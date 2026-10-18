// The agent-mesh daemon — one per host (a laptop or a remote box).
//
// Responsibilities (the host's single point of contact):
//   1. Owns the ONLY Redis connection on the host.
//   2. Exposes a local HTTP API over a Unix domain socket for agent processes
//      to register / publish / read through (they never touch Redis).
//   3. Tails the Redis channels of every locally-registered agent and pushes
//      each message DIRECTLY into the running process via its declared delivery
//      transport (sse / claude-resume / fifo / file / exec), backed by a durable
//      inbox file for turn-based catch-up.
//
// Run:  AGENT_MESH_REDIS_URL=redis://localhost:6379 tsx src/daemon.ts

import { z } from "zod"
import { verifyEndpoint, runCommand } from "./managed-delivery.js"
import { bindManagedActor, ownerKey, type LocalAgent } from "./local-registration.js"
import { ManagedScheduler } from "./managed-scheduler.js"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync, rmSync, openSync, writeSync, closeSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { getMeshRedis, createMeshBlockingClient, resetMeshRedis, type MeshRedis } from "./redis.js"
import {
  heartbeat,
  listAgents,
  lookupAgent,
  publish,
  readBroadcast,
  readInbox,
  registerAgent,
  setAgentStatus,
  unregisterAgent,
  waitForMessages,
} from "./hub.js"
import { broadcastKey, hostBroadcastKey, inboxKey } from "./keys.js"
import { agentIdSchema, BROADCAST, publishInputSchema, registerInputSchema, watchAckInputSchema, type MeshMessage } from "./types.js"
import { log } from "./log.js"
import { deliverToProcess, deliverTransportSchema, DEFAULT_DELIVER, type DeliverTransport } from "./delivery.js"
import { probeSessionLiveness, type LivenessEvidence } from "./claude-delivery.js"
import {
  ackWatch,
  appendToInbox,
  ensureHome,
  getAgentState,
  getLocalAgents,
  meshHome,
  peekWatch,
  readUnread,
  readInboxLines,
  removeLocalAgent,
  retireLocalAgent,
  setDeliverCursor,
  setLocalAgent,
  socketPath,
  type LocalAgentDef,
} from "./local-store.js"

const BROADCAST_CURSOR_ID = "__broadcast__"
// Daemon-wide cursor for THIS host's host-broadcast stream. Like the broadcast
// cursor it's shared across all local agents (a host-broadcast is delivered to
// every one of them), so one cursor per daemon — keyed to its single host stream.
const HOST_BROADCAST_CURSOR_ID = "__host_broadcast__"
const HEARTBEAT_MS = 15_000
const BLOCK_MS = 1_000
const DEFAULT_LIVENESS_SWEEP_MS = 60_000
// Watchdog: how often to check the redis clients are healthy, and how long the
// delivery loop may go without a single successful XREAD tick before we treat the
// consumer as STALLED and force-rebuild its blocking client. With BLOCK_MS=1000
// the loop ticks roughly once a second when healthy, so 30s of total silence is a
// strong signal the connection is wedged (not just idle).
const WATCHDOG_MS = 10_000
const CONSUMER_STALL_MS = 30_000

function livenessSweepMs(): number {
  const raw = Number(process.env.AGENT_MESH_LIVENESS_SWEEP_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIVENESS_SWEEP_MS
}

class MeshDaemon {
  private scheduler = new ManagedScheduler({ verify: verifyEndpoint, run: runCommand })
  private mutations: Promise<unknown> = Promise.resolve()
  private bindingChanges = new Set<string>()
  private redis!: MeshRedis
  private blocking!: MeshRedis
  private local = new Map<string, LocalAgent>()
  private sse = new Map<string, Set<ServerResponse>>()
  private running = true
  // Last time the delivery loop completed an XREAD round-trip (success OR a clean
  // timeout). The watchdog uses this to detect a wedged consumer. Initialised at
  // start so a freshly-started daemon isn't flagged before its first tick.
  private lastConsumerTickAt = Date.now()
  // Guards against two concurrent blocking-client rebuilds (deliveryLoop catch +
  // watchdog can both notice a dead client at once).
  private rebuildingBlocking = false

  async start(): Promise<void> {
    ensureHome()
    // Exactly one daemon per host (the socket + delivery loop are host-wide). Take
    // the lock BEFORE opening Redis connections so a duplicate exits cheaply.
    this.acquireSingletonLockOrExit()
    this.redis = await getMeshRedis()
    this.blocking = await createMeshBlockingClient()

    // Resume agents this daemon served before a restart.
    for (const def of Object.values(getLocalAgents())) {
      // local-agents.json is read back as-is; an id that would not pass /register
      // must not be served (its inbox path is derived from it).
      if (!agentIdSchema.safeParse(def.id).success) {
        log.warn("invalid persisted agent id; actor not restored", { id: String(def.id).slice(0, 140) })
        continue
      }
      const parsed = deliverTransportSchema.safeParse(def.deliver ?? DEFAULT_DELIVER)
      if (!parsed.success) {
        log.warn("invalid persisted transport; actor not restored", { id: def.id })
        continue
      }
      const deliver = parsed.data
      const claim = await this.redis.get(ownerKey(def.id))
      if (deliver.type === "managed" ? claim !== deliver.generation : claim != null) {
        log.warn("restore skips actor owned by a different binding", { id: def.id })
        continue
      }
      this.scheduler.wakeups.restore(def.id)
      this.local.set(def.id, { def, deliver, dead: false })
      await registerAgent(this.redis, { id: def.id, role: def.role, host: this.hostName(), meta: def.meta })
    }

    this.startHttpServer()
    // Each background loop is supervised: if its body ever throws or returns while
    // the daemon is still running (e.g. a delivery-loop iteration hits an
    // unexpected synchronous throw the inner guards didn't cover), restart it
    // instead of leaving it dead. This is the restart mechanism the watchdog
    // itself lacks for a crashed loop.
    this.superviseLoop("delivery", () => this.deliveryLoop())
    this.superviseLoop("heartbeat", () => this.heartbeatLoop())
    this.superviseLoop("liveness-sweep", () => this.livenessSweepLoop())
    this.superviseLoop("watchdog", () => this.watchdogLoop())
    this.superviseLoop("managed-wakeups", async () => {
      while (this.running) {
        for (const [id, agent] of this.local) {
          try {
            if (agent.deliver.type === "managed" && !this.bindingChanges.has(id))
              this.scheduler.schedule({ id, transport: agent.deliver, owns: () => this.owns(id, agent) })
          } catch (error) {
            log.warn("managed scheduling failed; state retained", { id, error: String(error) })
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    })
    log.info("daemon started", { socket: socketPath(), localAgents: [...this.local.keys()] })
    process.stdout.write(`[agent-mesh] daemon listening on ${socketPath()} (redis owned, ${this.local.size} local agents)\n`)
  }

  private hostName(): string {
    return process.env.AGENT_MESH_HOSTNAME ?? process.env.HOSTNAME ?? "unknown-host"
  }

  // Ensure exactly one daemon per host via an atomic pidfile lock. If a live
  // daemon already holds it, print a notice and exit(0) — running a second one is
  // a no-op, not an error (matters for a bootstrap where several agents may race
  // to start it). A stale lock (dead pid, e.g. after SIGKILL) is
  // reclaimed. The lock is released on clean exit / SIGINT / SIGTERM.
  private acquireSingletonLockOrExit(): void {
    const lockPath = join(meshHome(), "daemon.pid")
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0) // signal 0 = existence check
        return true
      } catch (e) {
        return (e as { code?: string }).code === "EPERM" // exists but not ours
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockPath, "wx") // O_CREAT|O_EXCL — atomic, fails if present
        writeSync(fd, String(process.pid))
        closeSync(fd)
        const release = () => {
          try {
            if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
              rmSync(lockPath)
            }
          } catch {
            /* best-effort */
          }
        }
        process.on("exit", release)
        for (const sig of ["SIGINT", "SIGTERM"] as const) {
          process.on(sig, () => {
            release()
            process.exit(0)
          })
        }
        return
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") {
          throw e
        }
        const existingPid = Number(readFileSync(lockPath, "utf8").trim())
        if (Number.isInteger(existingPid) && existingPid !== process.pid && isAlive(existingPid)) {
          process.stdout.write(`[agent-mesh] daemon already running (pid ${existingPid}); not starting another.\n`)
          process.exit(0)
        }
        rmSync(lockPath, { force: true }) // stale lock — reclaim and retry once
      }
    }
    process.stderr.write("[agent-mesh] could not acquire daemon lock; exiting.\n")
    process.exit(1)
  }

  private parseDeliver(raw: unknown): DeliverTransport {
    if (raw == null) {
      return DEFAULT_DELIVER
    }
    return deliverTransportSchema.parse(raw)
  }

  // ---- local registration ----

  private async registerLocal(input: {
    id: string
    role: string
    meta?: Record<string, unknown>
    deliver?: unknown
  }): Promise<LocalAgentDef & { sessionTakeover: boolean; previousSession: string | null }> {
    const base = registerInputSchema.parse({ id: input.id, role: input.role, host: this.hostName(), meta: input.meta ?? {} })
    const local = this.local.get(base.id)
    const owner = await this.redis.get(ownerKey(base.id))
    if (owner != null) {
      if (
        local?.deliver.type !== "managed" ||
        owner !== local.deliver.generation ||
        input.deliver != null ||
        base.meta.session !== local.deliver.owner?.session
      )
        throw new Error("actor has a binding; inspect it and use generation-checked rebind")
      return { ...local.def, sessionTakeover: false, previousSession: local.deliver.owner?.session ?? null }
    }
    const deliver = this.parseDeliver(input.deliver ?? local?.def.deliver)
    if (deliver.type === "managed") throw new Error("managed transports require /bind verification")
    // Takeover detection: an id owns one inbox and one deliver transport. If this
    // register carries a DIFFERENT meta.session than the live registry record,
    // a second session is claiming an id another session already uses — its
    // wake-ups would be silently stolen. We allow it (last-write-wins is the
    // model) but surface it loudly so the caller can re-derive a unique id.
    const existing = await lookupAgent(this.redis, base.id)
    const previousSession = typeof existing?.meta.session === "string" ? existing.meta.session : null
    const newSession = typeof base.meta.session === "string" ? base.meta.session : null
    // Only flag when BOTH sides carry a session and they differ — a register
    // without meta.session (e.g. a plain refresh) is ambiguous, not a takeover.
    const sessionTakeover = previousSession != null && newSession != null && previousSession !== newSession
    if (sessionTakeover) {
      // session ids truncated in logs: enough to correlate, nothing to replay
      log.warn("register takes over an id owned by a different session — wake-ups now route to the new session", {
        id: base.id,
        previousSession: previousSession.slice(0, 8),
        newSession: newSession.slice(0, 8),
      })
    }
    const def: LocalAgentDef = { id: base.id, role: base.role, meta: base.meta, deliver }
    // A fresh LocalAgent (dead:false) re-arms the online→dead transition, so a
    // re-registered (revived) process flips back to online and can die-and-notify
    // again later.
    this.local.set(def.id, { def, deliver, dead: false })
    setLocalAgent(def)
    await registerAgent(this.redis, { id: def.id, role: def.role, host: this.hostName(), meta: def.meta })
    // Start each cursor at "now" so a newly-registered agent doesn't replay
    // backlog — its own inbox, plus the two daemon-wide fan-out streams (which
    // default to "0" and would otherwise replay all history on the first tick).
    await this.initCursorIfUnset(def.id, inboxKey(def.id))
    await this.initCursorIfUnset(BROADCAST_CURSOR_ID, broadcastKey())
    await this.initCursorIfUnset(HOST_BROADCAST_CURSOR_ID, hostBroadcastKey(this.hostName()))
    log.info("registered local agent", { id: def.id, role: def.role, deliver: deliver.type })
    return { ...def, sessionTakeover, previousSession }
  }

  private async owns(id: string, agent: LocalAgent): Promise<boolean> {
    if (this.local.get(id) !== agent) return false
    const claim = await this.redis.get(ownerKey(id))
    if (this.local.get(id) !== agent) return false
    const owned = agent.deliver.type === "managed" ? claim === agent.deliver.generation : claim == null
    if (!owned) {
      // Stop tailing a stolen stream instead of busy-looping its old cursor.
      this.local.delete(id)
      log.warn("local actor lost ownership; delivery stopped", { id })
    }
    return owned
  }

  private async bind(raw: unknown): Promise<LocalAgentDef> {
    const { id } = z.object({ id: agentIdSchema }).parse(raw)
    // Verification awaits manager I/O. Reserve the actor for the entire change
    // so the scheduler cannot start a send between the busy check and CAS.
    this.bindingChanges.add(id)
    try {
      const def = await bindManagedActor({ raw, local: this.local, redis: this.redis, scheduler: this.scheduler, host: this.hostName() })
      await this.initCursorIfUnset(BROADCAST_CURSOR_ID, broadcastKey())
      await this.initCursorIfUnset(HOST_BROADCAST_CURSOR_ID, hostBroadcastKey(this.hostName()))
      return def
    } finally {
      this.bindingChanges.delete(id)
    }
  }

  private async lastId(streamKey: string): Promise<string> {
    const last = await this.redis.xRevRange(streamKey, "+", "-", { COUNT: 1 })
    return last.length > 0 ? last[0].id : "0"
  }

  // Point an unset cursor ("0") at the stream's last id, so the next delivery
  // tick starts from "now" rather than replaying history. No-op once set.
  private async initCursorIfUnset(cursorId: string, streamKey: string): Promise<void> {
    if (getAgentState(cursorId).deliverCursor === "0") {
      setDeliverCursor(cursorId, await this.lastId(streamKey))
    }
  }

  // ---- delivery loop: Redis -> process ----

  private buildCursors(): Record<string, string> {
    const cursors: Record<string, string> = {}
    for (const id of this.local.keys()) {
      cursors[inboxKey(id)] = getAgentState(id).deliverCursor
    }
    if (this.local.size > 0) {
      cursors[broadcastKey()] = getAgentState(BROADCAST_CURSOR_ID).deliverCursor
      // Tail this host's host-broadcast stream too (only this daemon consumes it).
      cursors[hostBroadcastKey(this.hostName())] = getAgentState(HOST_BROADCAST_CURSOR_ID).deliverCursor
    }
    return cursors
  }

  // Run a never-ending loop under supervision: if it throws or returns while the
  // daemon is still running, log and restart it after a short backoff. The loop
  // bodies are written to run forever (while this.running), so a return/throw is
  // always abnormal — this guarantees a crashed loop comes back rather than
  // silently staying dead (the failure mode an unsupervised `.catch()` left open).
  private superviseLoop(name: string, body: () => Promise<void>): void {
    const run = (): void => {
      body()
        .then(() => {
          if (this.running) {
            log.warn("loop returned unexpectedly; restarting", { loop: name })
          }
        })
        .catch((e) => {
          log.error("loop crashed; restarting", { loop: name, error: e })
        })
        .finally(() => {
          if (this.running) {
            setTimeout(run, 500)
          }
        })
    }
    run()
  }

  private async deliveryLoop(): Promise<void> {
    while (this.running) {
      const cursors = this.buildCursors()
      if (Object.keys(cursors).length === 0) {
        await new Promise((r) => setTimeout(r, 300))
        continue
      }
      let messages: MeshMessage[] = []
      try {
        messages = await waitForMessages(this.blocking, { cursors, blockMs: BLOCK_MS, count: 200 })
        // A completed XREAD (rows or a clean BLOCK timeout) proves the consumer
        // connection is alive — record it so the watchdog doesn't flag a stall.
        this.lastConsumerTickAt = Date.now()
      } catch (e) {
        // A transient redis blip lands here. The resilient client reconnects on
        // its own and the next XREAD resumes from the persisted cursors (no loss),
        // BUT if the client ended up permanently closed (isOpen=false) it never
        // will — so rebuild it before backing off. Cursors live in state.json, so
        // a fresh blocking client picks up exactly where we left off.
        log.warn("XREAD failed; backing off", { error: (e as Error).message, blockingOpen: this.blocking.isOpen })
        if (!this.blocking.isOpen) {
          await this.rebuildBlockingClient("delivery-loop")
        }
        await new Promise((r) => setTimeout(r, 500))
        continue
      }
      for (const msg of messages) {
        try {
          await this.routeMessage(msg)
        } catch (e) {
          // Stop this fetched batch on storage failure. Advancing a later
          // message's cursor could otherwise skip the failed message forever.
          log.warn("routeMessage failed; retaining cursor for retry", {
            id: msg.id,
            channel: msg.channel,
            error: (e as Error).message,
          })
          await new Promise((resolve) => setTimeout(resolve, 500))
          break
        }
      }
    }
  }

  // Tear down and re-create the dedicated blocking client. Idempotent under
  // concurrent callers (deliveryLoop + watchdog) via a simple in-flight guard.
  // Never throws: on failure it leaves the old client in place and the caller's
  // backoff will retry. Delivery cursors are persisted, so the rebuilt client
  // resumes from the last delivered id with no message loss.
  private async rebuildBlockingClient(reason: string): Promise<void> {
    if (this.rebuildingBlocking) {
      return
    }
    this.rebuildingBlocking = true
    try {
      log.warn("rebuilding blocking redis client", { reason })
      try {
        // destroy(), not a graceful close(): we only rebuild when the client is
        // already broken/stalled, and a graceful close would itself block waiting
        // on the stuck in-flight XREAD. destroy() forcibly tears it down and
        // rejects any pending command (which unparks the delivery loop).
        this.blocking.destroy()
      } catch {
        /* best-effort teardown */
      }
      this.blocking = await createMeshBlockingClient()
      this.lastConsumerTickAt = Date.now()
      log.info("blocking redis client rebuilt", { reason })
    } catch (e) {
      log.warn("failed to rebuild blocking redis client; will retry", { reason, error: (e as Error).message })
    } finally {
      this.rebuildingBlocking = false
    }
  }

  // Self-heal watchdog. Two failure modes it closes off, on top of the
  // never-give-up reconnect strategy in redis.ts:
  //   1. a redis client that somehow ended up permanently closed (isOpen=false) —
  //      rebuild it (shared via the singleton, blocking directly);
  //   2. a consumer that is "connected" but wedged — no XREAD has completed for
  //      CONSUMER_STALL_MS even though agents are registered — force a rebuild of
  //      the blocking client to break the stall.
  private async watchdogLoop(): Promise<void> {
    while (this.running) {
      await new Promise((r) => setTimeout(r, WATCHDOG_MS))
      try {
        await this.watchdogTick()
      } catch (e) {
        log.warn("watchdog tick failed", { error: (e as Error).message })
      }
    }
  }

  private async watchdogTick(): Promise<void> {
    if (!this.redis.isOpen) {
      log.warn("shared redis client closed; resetting singleton")
      await resetMeshRedis()
      this.redis = await getMeshRedis()
    }
    if (!this.blocking.isOpen) {
      // A closed blocking client is the unambiguous case — rebuild and we're done
      // for this tick (don't also fall through to the stall check and rebuild a
      // second time; lastConsumerTickAt is reset by the rebuild anyway).
      await this.rebuildBlockingClient("watchdog:blocking-closed")
      return
    }
    // Stall detection only matters when there's something to consume, and only
    // signals a genuine WEDGE when the client believes it's connected (isReady)
    // yet no XREAD has completed for CONSUMER_STALL_MS. If the client is NOT ready
    // it's a known outage — the reconnect machinery + socketTimeout own that path,
    // so rebuilding would just race them (and block on a connect that can't
    // succeed until redis returns).
    const stalledFor = Date.now() - this.lastConsumerTickAt
    if (this.local.size > 0 && this.blocking.isReady && stalledFor > CONSUMER_STALL_MS && !this.rebuildingBlocking) {
      log.warn("consumer appears stalled while connected; forcing blocking-client rebuild", { stalledForMs: stalledFor })
      await this.rebuildBlockingClient("watchdog:consumer-stalled")
    }
  }

  private async routeMessage(msg: MeshMessage): Promise<void> {
    // Fan-out channels (mesh-wide + this host's) deliver to every local agent;
    // a direct message goes to its one recipient. Each advances its own cursor.
    if (msg.channel === broadcastKey()) {
      await this.fanOutToLocal(msg, BROADCAST_CURSOR_ID)
      return
    }
    if (msg.channel === hostBroadcastKey(this.hostName())) {
      await this.fanOutToLocal(msg, HOST_BROADCAST_CURSOR_ID)
      return
    }
    const id = msg.to
    if (this.local.has(id)) {
      const agent = this.local.get(id)!
      if (!(await this.owns(id, agent))) return
      this.deliverTo(id, msg)
      setDeliverCursor(id, msg.id)
    }
  }

  // Deliver a fan-out message to every agent on this host, then advance the
  // shared cursor for that fan-out stream (broadcast or this host's stream).
  private async fanOutToLocal(msg: MeshMessage, cursorId: string): Promise<void> {
    for (const [id, agent] of this.local) {
      if (await this.owns(id, agent)) this.deliverTo(id, msg)
    }
    setDeliverCursor(cursorId, msg.id)
  }

  private deliverTo(id: string, msg: MeshMessage): void {
    appendToInbox(id, msg) // durable buffer (turn-based catch-up)
    const agent = this.local.get(id)
    if (agent != null && agent.deliver.type !== "sse" && agent.deliver.type !== "none" && agent.deliver.type !== "managed") {
      const res = deliverToProcess(agent.deliver, msg)
      log.info("delivered", { to: id, type: msg.type, from: msg.from, transport: agent.deliver.type, ok: res.ok, detail: res.detail })
    }
    const subs = this.sse.get(id)
    if (subs != null) {
      for (const res of subs) {
        res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`)
      }
    }
  }

  private async heartbeatLoop(): Promise<void> {
    while (this.running) {
      await new Promise((r) => setTimeout(r, HEARTBEAT_MS))
      for (const [id, agent] of this.local) {
        if (!(await this.owns(id, agent))) continue
        // Heartbeat keeps lastSeen fresh so the host shows alive. A dead agent is
        // heartbeated WITH status "dead" so the death sticks (a plain heartbeat
        // would reset it to "online") while the host clearly isn't stale.
        await heartbeat(this.redis, { id, status: agent.dead ? "dead" : "online" }).catch(() => {})
      }
    }
  }

  // ---- liveness sweep: detect dead owning processes ----
  //
  // Registrations live in Redis independently of the session processes that own
  // them, so a killed worker keeps showing "online" and — emitting no messages —
  // gives an event-driven orchestrator nothing to react to (the 2026-06-11
  // incident: three workers killed, fleet stalled ~8h). This sweep periodically
  // probes each registration THIS host serves for a live owning process and, on
  // an online→dead transition, publishes ONE agent-died event.
  private async livenessSweepLoop(): Promise<void> {
    while (this.running) {
      await new Promise((r) => setTimeout(r, livenessSweepMs()))
      await this.sweepLiveness().catch((e) => log.warn("liveness sweep tick failed", { error: (e as Error).message }))
    }
  }

  private async sweepLiveness(): Promise<void> {
    // Snapshot first: markDead awaits (publish), and a concurrent /register can
    // mutate this.local mid-iteration.
    for (const [id, agent] of [...this.local]) {
      if (agent.deliver.type === "managed" || agent.def.meta.runtime === "codex") continue // manager probe owns runtime liveness; unknown is not dead
      if (agent.dead) {
        continue // already transitioned — exactly-once, no flapping on later sweeps
      }
      const session = this.sessionInfoFor(agent)
      if (session == null) {
        continue // no session/pid basis to probe — never declare death blindly
      }
      const ev = probeSessionLiveness({ sessionId: session.sessionId, pid: session.pid })
      if (ev.live) {
        continue
      }
      // Not live. Only declare DEAD with positive evidence the owner is gone: a
      // pid we existence-checked, or a transcript that existed and went idle.
      // With neither we can't distinguish idle-alive from dead — leave it online.
      if (ev.pidChecked == null && ev.transcriptAgeMs == null) {
        log.warn("liveness sweep: no basis to judge agent (no live pid, no transcript) — leaving online", { id, reason: ev.reason })
        continue
      }
      await this.markDead(id, agent, ev)
    }
  }

  // Where to find the owning session for an agent: a claude-resume transport
  // carries sessionId+pid explicitly; otherwise the CLI auto-injects them into
  // meta (meta.session / meta.pid) on every register, so poll-only agents are
  // probeable too. No session id at all → unprobeable (returns null).
  private sessionInfoFor(agent: LocalAgent): { sessionId: string; pid: number | null } | null {
    const transport = agent.deliver.type === "claude-resume" ? { sessionId: agent.deliver.sessionId, pid: agent.deliver.pid ?? null } : null
    const metaSession = typeof agent.def.meta.session === "string" && agent.def.meta.session !== "" ? agent.def.meta.session : null
    const sessionId = transport?.sessionId ?? metaSession
    if (sessionId == null) {
      return null
    }
    const pid = transport?.pid ?? this.metaPid(agent.def.meta)
    return { sessionId, pid }
  }

  private metaPid(meta: Record<string, unknown>): number | null {
    const raw = meta.pid
    const n = typeof raw === "number" ? raw : Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  }

  private async markDead(id: string, agent: LocalAgent, ev: LivenessEvidence): Promise<void> {
    // A /register (automated agent recovery) can race the death write. registerLocal
    // replaces this.local's slot with a fresh {dead:false} object and writes the
    // revived process's "online" to Redis. If we let "dead" land on top of that we
    // both clobber a live agent's status AND fire a false agent-died (the
    // orchestrator re-dispatches a ticket the revived worker is already running).
    // Guard on object IDENTITY both BEFORE the write and AFTER its await (the Redis
    // round-trip is the window the re-register can slip through).
    if (this.local.get(id) !== agent) {
      log.warn("liveness sweep: re-registration raced the death write — skipping", { id })
      return
    }
    agent.dead = true
    await setAgentStatus(this.redis, { id, status: "dead" }).catch((e) =>
      log.warn("failed to persist dead status", { id, error: (e as Error).message }),
    )
    const current = this.local.get(id)
    if (current !== agent) {
      // Revived during the await. Our "dead" may have landed after registerLocal's
      // "online" — restore the live truth and DON'T publish a false death.
      log.warn("liveness sweep: re-registration raced the death write — reverting status, no event", { id })
      if (current != null && !current.dead) {
        await setAgentStatus(this.redis, { id, status: "online" }).catch((e) =>
          log.warn("failed to restore online status", { id, error: (e as Error).message }),
        )
      }
      return
    }
    log.warn("liveness sweep: owning process is gone — marking agent dead", {
      id,
      ticket: agent.def.meta.ticket ?? null,
      evidence: ev.reason,
      lastTranscriptGrowthMs: ev.transcriptAgeMs,
    })
    await this.publishAgentDied(id, agent, ev)
  }

  // Convert the death into an EVENT: one note (corr=agent-died) to every agent
  // with role "orchestrator" (fallback: broadcast if there are none). Event-driven
  // orchestrators get woken instead of waiting forever on a worker that can't
  // reply. Body carries enough to act: id, the dead agent's meta (incl. ticket),
  // last transcript growth, and the evidence string.
  private async publishAgentDied(id: string, agent: LocalAgent, ev: LivenessEvidence): Promise<void> {
    const from = this.daemonAgentId()
    const body = {
      id,
      meta: agent.def.meta,
      last_transcript_growth: ev.transcriptAgeMs,
      evidence: ev.reason,
    }
    // Only ONLINE orchestrators: a dead/stale one can't consume, and its inbox
    // would just grow unbounded (no reader). If none are online, broadcast so a
    // reviving orchestrator (or any live agent) still sees the death.
    const orchestrators = (await listAgents(this.redis))
      .filter((a) => a.role === "orchestrator" && a.status === "online" && a.id !== id)
      .map((a) => a.id)
    const targets = orchestrators.length > 0 ? orchestrators : [BROADCAST]
    for (const to of targets) {
      await publish(this.redis, { from, to, type: "note", body, correlationId: "agent-died" }).catch((e) =>
        log.warn("failed to publish agent-died event", { id, to, error: (e as Error).message }),
      )
    }
    log.info("published agent-died event", { id, targets })
  }

  // A stable, charset-safe sender id for daemon-originated events.
  private daemonAgentId(): string {
    return `daemon.${this.hostName()
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 110)}`
  }

  // ---- local HTTP API (unix socket) ----

  private startHttpServer(): void {
    const sock = socketPath()
    if (existsSync(sock)) {
      rmSync(sock)
    }
    const server = createServer((req, res) => {
      const mutation = req.method === "POST" && ["/register", "/bind", "/retire", "/unregister"].includes(req.url ?? "")
      const task = mutation ? this.mutations.then(() => this.handle(req, res)) : this.handle(req, res)
      if (mutation) this.mutations = task.catch(() => {})
      task.catch((e) => {
        this.json(res, 500, { error: (e as Error).message })
      })
    })
    server.listen(sock)
    server.on("error", (e) => log.error("http server error", { error: e }))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost")
    const route = `${req.method} ${url.pathname}`

    if (route === "GET /health") {
      return this.json(res, 200, { ok: true, hostname: this.hostName(), socket: socketPath(), localAgents: [...this.local.keys()] })
    }
    if (route === "GET /agents") {
      return this.json(res, 200, await listAgents(this.redis))
    }
    if (route === "GET /lookup") {
      const id = this.requireValidId(res, url.searchParams.get("id"))
      if (id == null) {
        return
      }
      return this.json(res, 200, await lookupAgent(this.redis, id))
    }
    if (route === "POST /bind") {
      return this.json(res, 200, await this.bind(await this.readBody(req)))
    }
    if (route === "GET /delivery" || route === "GET /receive") {
      const id = this.requireValidId(res, url.searchParams.get("id"))
      if (id == null) return
      const agent = this.local.get(id)
      if (agent?.deliver.type !== "managed")
        return this.json(res, 200, {
          transport: agent?.deliver.type ?? null,
          automaticWakeup: false,
          reason: "legacy-capability-not-declared",
        })
      const transport = agent.deliver
      const owns = await this.owns(id, agent)
      if (route === "GET /receive") {
        if (!owns || url.searchParams.get("generation") !== transport.generation) throw new Error("stale binding generation")
        return this.json(res, 200, {
          id,
          generation: transport.generation,
          batch: this.scheduler.wakeups.claim({ id, generation: transport.generation, now: Date.now() }),
        })
      }
      const state = this.scheduler.wakeups.state(id)
      const targetVerification =
        owns && transport.selection.type === "adapter" && transport.owner != null
          ? await verifyEndpoint({ endpoint: transport.selection.endpoint, owner: transport.owner })
          : null
      return this.json(res, 200, {
        id,
        transport,
        owns,
        targetVerification,
        pendingMessages: readInboxLines(id).length - (state?.receivedThrough ?? 0),
        automaticWakeup: transport.selection.type === "monitor" ? null : owns && transport.selection.type === "adapter",
        state,
        receiptConfirmed: state?.lastReceipt != null,
        tickReady: transport.tickMs != null && state?.lastTickReceipt != null,
        reason: owns ? transport.selection.reason : "owner-changed",
      })
    }
    if (route === "POST /receipt" || route === "POST /retry" || route === "POST /retire") {
      const body = z
        .object({ id: agentIdSchema, generation: z.string().uuid(), token: z.string().uuid().optional() })
        .parse(await this.readBody(req))
      const retiring = route === "POST /retire"
      if (retiring) this.bindingChanges.add(body.id)
      try {
        const agent = this.local.get(body.id)
        if (agent?.deliver.type !== "managed" || agent.deliver.generation !== body.generation || !(await this.owns(body.id, agent)))
          throw new Error("stale binding generation")
        if (route === "POST /retire") {
          if (this.scheduler.busy(body.id)) throw new Error("delivery in flight; retry retirement after it settles")
          if (["sending", "ambiguous"].includes(this.scheduler.wakeups.state(body.id)?.batch?.outcome ?? ""))
            throw new Error("ambiguous submission: inspect and resolve the pending batch before retirement")
          await this.redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("SET", KEYS[1], ARGV[2]) end return nil', {
            keys: [ownerKey(body.id)],
            arguments: [body.generation, `retired:${body.generation}`],
          })
          this.scheduler.wakeups.retire(body.id)
          retireLocalAgent(body.id)
          this.local.delete(body.id)
          await setAgentStatus(this.redis, { id: body.id, status: "offline" })
          return this.json(res, 200, { id: body.id, retired: true, inboxPreserved: true })
        }
        if (body.token == null) throw new Error("batch token required")
        if (route === "POST /receipt") this.scheduler.wakeups.ack({ ...body, token: body.token, now: Date.now() })
        else {
          if (this.scheduler.busy(body.id)) throw new Error("delivery in flight")
          if (
            !this.scheduler.wakeups.update({
              ...body,
              token: body.token,
              patch: { outcome: "pending", attempts: 0, nextAttempt: Date.now(), reason: "explicit-retry" },
            })
          )
            throw new Error("stale batch token")
        }
        return this.json(res, 200, { id: body.id, state: this.scheduler.wakeups.state(body.id) })
      } finally {
        if (retiring) this.bindingChanges.delete(body.id)
      }
    }

    if (route === "GET /inbox") {
      // id flows into a host-local file path, so validate the charset before use.
      const id = this.requireValidId(res, url.searchParams.get("id"))
      if (id == null) {
        return
      }
      const peek = url.searchParams.get("peek") === "1"
      return this.json(res, 200, readUnread(id, { peek }))
    }
    if (route === "GET /watch") {
      // peek for `agent-mesh watch`: messages past the watch cursor, each with
      // its absolute ack token. Never consumes (readCount untouched).
      const id = this.requireValidId(res, url.searchParams.get("id"))
      if (id == null) {
        return
      }
      if (!this.local.has(id) && (await this.redis.get(ownerKey(id))) != null) throw new Error("retired watch binding")
      const transport = this.local.get(id)?.deliver
      if (transport?.type === "managed" && transport.selection.type !== "monitor")
        throw new Error("watch disabled for this binding; use receive/receipt")
      return this.json(res, 200, { ...peekWatch(id), ...(transport?.type === "managed" ? { generation: transport.generation } : {}) })
    }
    if (route === "POST /watch/ack") {
      const input = watchAckInputSchema.parse(await this.readBody(req))
      if (!this.local.has(input.id) && (await this.redis.get(ownerKey(input.id))) != null) throw new Error("retired watch binding")
      const transport = this.local.get(input.id)?.deliver
      if (transport?.type === "managed" && (transport.selection.type !== "monitor" || input.generation !== transport.generation))
        throw new Error("stale watch callback")
      return this.json(res, 200, { id: input.id, ...ackWatch(input.id, input.upTo) })
    }
    if (route === "GET /history") {
      // Read-only xRange over the mesh streams: works for ANY registered agent
      // (not just locally-served ones) and for the literal id "broadcast".
      // Never advances delivery or read cursors — safe for inspection tooling.
      const id = this.requireValidId(res, url.searchParams.get("id"))
      if (id == null) {
        return
      }
      const limitRaw = Number(url.searchParams.get("limit") ?? 200)
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200
      // newest N (the tail of a busy stream), returned chronological — the
      // dashboard shows recent activity, not the oldest messages on record.
      const messages =
        id === "broadcast"
          ? await readBroadcast(this.redis, { limit, newest: true })
          : await readInbox(this.redis, { agentId: id, limit, newest: true })
      return this.json(res, 200, messages)
    }
    if (route === "GET /activity") {
      // Latest stream id per registered agent's inbox, plus the mesh-wide
      // broadcast stream and each host's fan-out stream — lets a viewer compute
      // "new since I last looked" for every channel an agent can receive on,
      // without reading any message bodies. Read-only, no cursor side effects.
      const registry = await listAgents(this.redis)
      const hosts = [...new Set(registry.map((a) => a.host).filter((h): h is string => h != null && h !== ""))]
      const activity: { agents: Record<string, string>; broadcast: string; hosts: Record<string, string> } = {
        agents: {},
        broadcast: await this.lastId(broadcastKey()),
        hosts: {},
      }
      await Promise.all([
        ...registry.map(async (agent) => {
          activity.agents[agent.id] = await this.lastId(inboxKey(agent.id))
        }),
        ...hosts.map(async (host) => {
          activity.hosts[host] = await this.lastId(hostBroadcastKey(host))
        }),
      ])
      return this.json(res, 200, activity)
    }
    if (route === "GET /subscribe") {
      const id = this.requireValidId(res, url.searchParams.get("id"))
      if (id == null) {
        return
      }
      if ((await this.redis.get(ownerKey(id))) != null) throw new Error("bound actors use receive/receipt or the declared Monitor watch")
      return this.handleSubscribe(req, res, id)
    }
    if (route === "POST /register") {
      const body = await this.readBody(req)
      const def = await this.registerLocal(body as { id: string; role: string; meta?: Record<string, unknown>; deliver?: unknown })
      return this.json(res, 200, def)
    }
    if (route === "POST /unregister") {
      const body = (await this.readBody(req)) as { id?: string }
      const id = this.requireValidId(res, body.id ?? null)
      if (id == null) {
        return
      }
      if ((await this.redis.get(ownerKey(id))) != null) throw new Error("bound actors must retire with generation; inbox is preserved")
      // local side: stop serving + don't resurrect on restart + drop buffers
      this.local.delete(id)
      const subs = this.sse.get(id)
      if (subs != null) {
        for (const sub of subs) {
          sub.end()
        }
        this.sse.delete(id)
      }
      removeLocalAgent(id)
      // mesh side: registry entry + inbox stream
      const result = await unregisterAgent(this.redis, { id })
      log.info("unregistered agent", { id, existedInRegistry: result.removed })
      return this.json(res, 200, { id, removed: result.removed })
    }
    if (route === "POST /publish") {
      const body = await this.readBody(req)
      const input = publishInputSchema.parse(body)
      const msg = await publish(this.redis, input)
      return this.json(res, 200, msg)
    }
    return this.json(res, 404, { error: `no route ${route}` })
  }

  private handleSubscribe(req: IncomingMessage, res: ServerResponse, id: string): void {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
    res.write(`event: ready\ndata: ${JSON.stringify({ id })}\n\n`)
    let set = this.sse.get(id)
    if (set == null) {
      set = new Set()
      this.sse.set(id, set)
    }
    set.add(res)
    req.on("close", () => {
      set?.delete(res)
    })
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    for await (const c of req) {
      chunks.push(c as Buffer)
    }
    if (chunks.length === 0) {
      return {}
    }
    return JSON.parse(Buffer.concat(chunks).toString())
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(data))
  }

  // Validate an id query param against the safe agent-id charset before it's
  // used to build a Redis key or file path. Returns null (and writes a 400) on
  // a bad id so callers can early-return.
  private requireValidId(res: ServerResponse, raw: string | null): string | null {
    const parsed = agentIdSchema.safeParse(raw ?? "")
    if (!parsed.success) {
      this.json(res, 400, { error: "invalid agent id" })
      return null
    }
    return parsed.data
  }
}

// Compact, log-safe rendering of a rejection/exception cause: name+message only
// (no full payload), newlines stripped (log-injection guard), length-capped. The
// reason for a redis rejection is a short Error message; we never need to dump an
// arbitrary payload to keep the daemon alive.
function safeReason(value: unknown): string {
  const raw = value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  return raw.replace(/[\r\n]+/g, " ").slice(0, 300)
}

async function main() {
  // Last-resort process guards. The daemon's #1 job is to STAY UP through a
  // transient redis outage: a stray redis command rejection (the node-redis
  // reconnect machinery rejects pending promises) must never take the process
  // down — that's the exact failure that left the fleet without a hub for ~10h
  // (ECONNREFUSED on the socket = process gone). Install BEFORE start() so even a
  // failure during boot is observable rather than silent.
  //
  // unhandledRejection: ALWAYS keep running. The incident was async rejections
  // from redis, and a reconnect storm can produce a burst of them — exiting on
  // those would reintroduce the wedge. Log a sanitized cause and carry on; the
  // resilient client + watchdog do the actual recovery.
  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection (kept alive)", { reason: safeReason(reason) })
  })

  // uncaughtException is deliberately NOT swallowed. The incident path is async
  // redis rejections (handled above); a SYNCHRONOUS uncaught throw is a different
  // class — a broken invariant in a handler, a null deref in the liveness sweep —
  // after which Node documents the process as being in an undefined state. Limping
  // on with a half-updated `this.local` / `sse` / cursor map would be a SILENT
  // malfunction that reports healthy. We log and exit non-zero so a clean process
  // is started instead (the agent-mesh skill re-bootstraps the daemon whenever
  // `agent-mesh health` fails; the singleton-lock release runs on 'exit', freeing
  // the pidfile for the restart).
  process.on("uncaughtException", (error) => {
    log.error("uncaughtException — exiting for a clean restart", { error })
    process.exit(1)
  })

  const daemon = new MeshDaemon()
  await daemon.start()
}

main().catch((e) => {
  log.error("daemon failed to start", { error: e })
  process.stderr.write(`${(e as Error).stack ?? e}\n`)
  process.exit(1)
})
