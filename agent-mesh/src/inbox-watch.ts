// The console's inbound path: watch the operator's mesh inbox and push arrivals to
// every open browser over one SSE stream.
//
// ── Why this is not the daemon's SSE ─────────────────────────────────────────
// The daemon does have a `GET /subscribe` SSE endpoint, and it looks like exactly
// the plumbing this needs. It is not. `deliverTo()` — and therefore that fan-out —
// only runs for agents in the daemon's `local` map (`if (this.local.has(id))`), so
// the daemon never even READS `mesh:inbox:operator`.
// `operator` is an inbox nobody serves. Subscribing to it would attach a listener
// that stays healthy and silently receives nothing, forever — the worst shape of
// failure. Making it work would mean registering `operator` as a local agent, which
// is shared daemon state that other fleets depend on.
//
// So this watcher tails the stream itself, through the same read-only `/history`
// proxy the dashboard already uses. One poll serves every connected tab: the cost is
// per host, not per browser.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { ServerResponse } from "node:http"
import { dirname, join } from "node:path"
import { consoleDatabaseDir } from "./console-db-url.js"
import { quietOutcome, routeIntent, selectBatch } from "./inbox-routing.js"
import { compareStreamIds, inspect } from "./mesh-read.js"
import type { MeshMessage } from "./types.js"
import { securityHeaders } from "./ui-guards.js"

// Fast enough to feel like a push in conversation, slow enough that an idle console
// is not hammering the daemon socket. The latency that matters is human, and an
// answer landing 1.5s after it was published reads as instant.
const POLL_MS = 1500
// How many messages land in one poll. A batch SIZE, not a truncation: the rest arrive
// on the next poll (see selectBatch). Replays of old mail are stopped by the persisted
// cursor and the recency cutoff, not by this.
const MAX_BURST = 20
// The stored position of an inbox that was empty when the console first polled it:
// lower than every real stream id.
const EMPTY_INBOX_HEAD = "0-0"
// How far back a restart is allowed to reach. Long enough to cover a deploy or a
// crash-loop, short enough that a console started after an overnight outage does not
// open by announcing yesterday.
const CATCH_UP_MS = 30 * 60 * 1000
// A comment frame down every idle stream. Two jobs: a write to a socket the client
// has dropped throws, which is how dead subscribers get pruned promptly; and an idle
// SSE stream is exactly what a reverse proxy likes to time out.
const HEARTBEAT_MS = 15_000
// How recently a tab must have said "I am visible" for an arrival to count as watched.
// Generous enough to survive an EventSource reconnect or a server restart (either of
// which briefly drops the socket while the operator is still looking at the screen), short
// enough that a phone put in a pocket starts getting notifications quickly.
const PRESENCE_TTL_MS = 45_000
// How many consecutive polls a batch may be held for a tab that says it is present but
// has no live socket. ~30s at POLL_MS. A tab whose stream is genuinely broken while it
// keeps beaconing would otherwise hold mail forever, so the hold gives up and pushes.
const MAX_HOLDS = 20
// Diagnostics only. Bounded because it is a debugging aid, not a log.
const ROUTING_HISTORY = 50
// Survives restarts so mail that lands WHILE the server is down is still delivered.
// Without it `head` re-seeds to the newest message on boot and everything that
// arrived during the gap is skipped — silently, forever. That is worse than a
// duplicate: a duplicate is noise, a skipped answer is one the operator never sees.
//
// Overridable because the cursor is SHARED STATE between processes, not per-process
// state: a second console started against the same mesh home reads and advances the
// same head, so a scratch instance silently consumes arrivals the live console would
// have shown the operator. Point a throwaway instance at its own file.
const HEAD_FILE = () => {
  const override = process.env.CONSOLE_INBOX_HEAD_FILE
  if (override != null && override !== "") {
    return override
  }
  return join(consoleDatabaseDir(), "console-inbox-head.json")
}

type Subscriber = { res: ServerResponse; alive: boolean; attachedAt: number }

/**
 * What happened to a batch of arrivals, and WHY, as data.
 *
 * The reason is carried rather than re-derived downstream: the log line, the
 * diagnostics endpoint and any future UI all read this value, so "why did that buzz
 * my phone while I was looking at it" is answerable by looking instead of by
 * reasoning about the code. `held` exists because of a real bug — see routeBatch.
 */
export type RoutingDecision =
  | { routed: "inline"; reason: "subscribers-present" | "subscribers-but-hidden"; subscribers: number }
  | { routed: "push"; reason: "no-presence" }
  | { routed: "push"; reason: "held-too-long" }
  /** Nothing was listening and the push reached no device. See `routeBatch`. */
  | { routed: "undeliverable"; reason: "no-subscriber-no-device" }
  | { routed: "held"; reason: "watching-but-detached"; attempt: number }
  | { routed: "dropped"; reason: "own-message" | "below-head" | "outside-recency" }

export type RoutingRecord = { at: string; decision: RoutingDecision; messageIds: string[]; from: string[] }

export class InboxWatcher {
  private readonly subscribers = new Set<Subscriber>()
  private timer: ReturnType<typeof setInterval> | null = null
  // The newest stream id already announced. Seeded from the CURRENT head on the
  // first poll rather than from zero, so opening the console does not narrate the
  // entire backlog as if it had just arrived.
  private head: string | null = null
  private polling = false
  private headLoaded = false
  private heartbeat: ReturnType<typeof setInterval> | null = null
  // Last time a FOREGROUNDED tab reported in. Socket count is not presence: it drops
  // to zero for a few seconds on every reconnect (so an arrival would be pushed while
  // the operator is watching) and stays above zero on a stale or backgrounded socket (so
  // nothing would ever be pushed while they are away). Both were observed. A visible-only beacon
  // is the honest signal.
  private lastPresenceAt = 0
  private holds = 0
  private readonly routingLog: RoutingRecord[] = []
  private lastHeadAdvanceAt: string | null = null
  private attachHistory: Array<{ at: string; event: "attach" | "detach"; total: number }> = []

  private readonly operatorId: () => string
  private quietHandler: ((messages: MeshMessage[]) => Promise<{ sent: number }>) | null = null
  // The newest id already reported as undeliverable, so a batch nobody can receive is
  // logged once rather than once per poll. Cleared when a tab attaches, because that is
  // the event that can change the answer.
  private undeliverableFor: string | null = null

  constructor(operatorId: () => string) {
    this.operatorId = operatorId
  }

  /**
   * Called for arrivals that land while NO tab is listening. A live subscriber
   * already narrates in the conversation; notifying as well would tell the operator
   * about something they are watching appear.
   */
  onQuietArrival(handler: (messages: MeshMessage[]) => Promise<{ sent: number }>): void {
    this.quietHandler = handler
  }

  /**
   * Begin polling without a tab attached. Push delivery depends on this: the whole
   * point is arrivals that land when nobody is looking, and a watcher that only runs
   * while a browser is connected can never see one.
   */
  arm(): void {
    this.start()
  }

  subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      ...securityHeaders("api"),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this an intermediate proxy can buffer the stream into uselessness.
      "X-Accel-Buffering": "no",
    })
    res.write(`event: ready\ndata: ${JSON.stringify({ operatorId: this.operatorId() })}\n\n`)
    const sub: Subscriber = { res, alive: true, attachedAt: Date.now() }
    this.subscribers.add(sub)
    // A batch held as undeliverable can be delivered now, so let the next poll offer it
    // again instead of staying silent because it has already been reported.
    this.undeliverableFor = null
    this.note("attach")
    res.on("close", () => {
      sub.alive = false
      this.subscribers.delete(sub)
      this.note("detach")
      this.stopIfIdle()
    })
    this.start()
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }

  /** Called by a tab that is on screen right now. */
  markPresent(): void {
    this.lastPresenceAt = Date.now()
  }

  get watching(): boolean {
    return Date.now() - this.lastPresenceAt < PRESENCE_TTL_MS
  }

  private start(): void {
    if (this.timer != null) {
      return
    }
    // Poll only while someone is listening. A dashboard left on a Roster tab should
    // cost nothing.
    this.timer = setInterval(() => void this.poll(), POLL_MS)
    if (this.heartbeat == null) {
      this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS)
    }
    void this.poll()
  }

  private stopIfIdle(): void {
    // The watcher keeps running with zero tabs open, and that is load-bearing for TWO
    // reasons, only one of which is obvious.
    //
    // 1. Push needs it: an arrival with nobody watching is the whole point.
    // 2. It is also what stops a REPLAY. `head` only advances while polling, so a
    //    watcher that stopped with the last tab would freeze its position, and the
    //    next tab to open would resume and emit everything that had arrived in
    //    between — narrating a pile of already-delivered mail into a fresh
    //    conversation as if it had just landed. That was observed on a build without
    //    a continuous poll.
    //
    // So do NOT "optimise" this into stopping when there are no tabs and no push
    // subscribers. The poll is cheap (one read per host, shared by every client); the
    // replay it prevents is not.
    if (this.subscribers.size > 0 || this.quietHandler != null || this.timer == null) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
  }

  private async poll(): Promise<void> {
    // Overlapping polls would double-announce a message on a slow socket.
    if (this.polling) {
      return
    }
    this.polling = true
    try {
      const me = this.operatorId()
      const view = await inspect(me, 60)
      const history = view.history
      if (!this.headLoaded) {
        this.headLoaded = true
        this.head = this.loadHead()
      }
      if (history.length === 0) {
        // An empty inbox is a position too: whatever arrives after it is new. Without
        // this, the first message a fresh operator id ever received became the
        // baseline below and was never shown.
        if (this.head == null) {
          this.setHead(EMPTY_INBOX_HEAD)
        }
        return
      }
      const newest = history[history.length - 1].id
      if (this.head == null) {
        // No stored position: this console has never run here. Baseline to the
        // current head rather than announcing the entire backlog on first start.
        this.setHead(newest)
        return
      }
      const cutoff = Date.now() - CATCH_UP_MS
      const fresh = history.filter((m) => {
        if (compareStreamIds(m.id, this.head as string) <= 0) {
          return false
        }
        // A stored head from a long outage would otherwise replay hours of mail as
        // if it had just landed.
        const at = new Date(m.ts).getTime()
        return Number.isNaN(at) || at >= cutoff
      })
      if (fresh.length === 0) {
        this.advance(newest)
        return
      }
      const batch = selectBatch({ fresh, me, maxBurst: MAX_BURST, newest })
      if (batch.kind === "own-only") {
        this.record({ routed: "dropped", reason: "own-message" }, fresh)
        this.advance(batch.through)
        return
      }
      await this.routeBatch({ inbound: batch.inbound, newest: batch.through })
    } catch {
      // A dropped poll is not an event. The daemon socket bounces during a restart;
      // the next tick recovers, and announcing an error as mesh traffic would be
      // worse than a second of silence.
    } finally {
      this.polling = false
    }
  }

  private loadHead(): string | null {
    try {
      const file = HEAD_FILE()
      if (!existsSync(file)) {
        return null
      }
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { head?: unknown }
      return typeof parsed.head === "string" && parsed.head !== "" ? parsed.head : null
    } catch {
      return null // a corrupt cursor costs a baseline, not a crash
    }
  }

  private setHead(id: string): void {
    this.head = id
    try {
      const file = HEAD_FILE()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ head: id }), { mode: 0o600 })
    } catch {
      // Losing the cursor degrades to the old behaviour rather than breaking the
      // watcher; the in-memory head still works for this process's lifetime.
    }
  }

  /**
   * Decide where a batch goes, and only then move the read position.
   *
   * The bug this closes: the position used to advance on ANNOUNCED rather than on
   * DELIVERED. If a foregrounded tab's stream was mid-reconnect — every restart, and
   * every network blip — `emit()` wrote to zero sockets, the position advanced anyway,
   * and the push was skipped because presence said they were there. The message reached
   * neither surface and nothing recorded that it had existed. An answer that simply
   * never appears is indistinguishable from an agent that never replied.
   *
   * So a batch that reaches nobody is HELD: the position does not move and the next
   * poll re-offers it. The hold is capped, because a tab that keeps beaconing while
   * its stream stays broken must not hold mail forever — past the cap it falls through
   * to push, which is the honest outcome.
   */
  private async routeBatch(args: { inbound: MeshMessage[]; newest: string }): Promise<void> {
    const intent = routeIntent({ subscribers: this.subscribers.size, watching: this.watching, holds: this.holds, maxHolds: MAX_HOLDS })

    if (intent.kind === "inline") {
      this.emit(args.inbound)
      this.holds = 0
      this.record(
        { routed: "inline", reason: intent.notify ? "subscribers-but-hidden" : "subscribers-present", subscribers: intent.subscribers },
        args.inbound,
      )
      // A socket received it, so the position moves regardless of the notification's
      // outcome: the batch is delivered, and the push is only the heads-up that it
      // arrived. Not awaited for the same reason — a slow push service must not hold the
      // next poll.
      this.advance(args.newest)
      if (intent.notify) {
        void this.quietHandler?.(args.inbound).catch(() => undefined)
      }
      return
    }

    if (intent.kind === "hold") {
      this.holds = intent.attempt
      // Deliberately NOT advancing: this batch has not been delivered to anything.
      this.record({ routed: "held", reason: "watching-but-detached", attempt: intent.attempt }, args.inbound)
      return
    }

    this.holds = 0
    const result = await this.quietHandler?.(args.inbound).catch(() => ({ sent: 0 }))
    const outcome = quietOutcome(result?.sent ?? 0)

    if (!outcome.advance) {
      // Logged once per batch rather than once per poll: this state can persist for
      // hours and the routing log is a debugging aid, not a tail of the same line.
      if (this.undeliverableFor !== args.newest) {
        this.undeliverableFor = args.newest
        this.record({ routed: "undeliverable", reason: "no-subscriber-no-device" }, args.inbound)
      }
      return
    }
    this.record({ routed: "push", reason: intent.reason }, args.inbound)
    this.advance(args.newest)
  }

  private advance(newest: string): void {
    if (this.head == null || compareStreamIds(newest, this.head) > 0) {
      this.setHead(newest)
      this.lastHeadAdvanceAt = new Date().toISOString()
    }
  }

  private record(decision: RoutingDecision, messages: MeshMessage[]): void {
    const entry: RoutingRecord = {
      at: new Date().toISOString(),
      decision,
      messageIds: messages.map((m) => m.id),
      from: [...new Set(messages.map((m) => m.from))],
    }
    this.routingLog.push(entry)
    if (this.routingLog.length > ROUTING_HISTORY) {
      this.routingLog.shift()
    }
    // Durable and greppable. This path runs with nobody watching; without a line here
    // a message that reached neither surface leaves no trace anywhere. Ids and reasons
    // only — never a message body, since these are real conversations.
    process.stdout.write(
      `[console] route=${decision.routed} reason=${decision.reason} n=${messages.length} from=${entry.from.join(",")} ids=${entry.messageIds.join(",")}\n`,
    )
  }

  private note(event: "attach" | "detach"): void {
    this.attachHistory.push({ at: new Date().toISOString(), event, total: this.subscribers.size })
    if (this.attachHistory.length > ROUTING_HISTORY) {
      this.attachHistory.shift()
    }
  }

  /** Read-only snapshot for the diagnostics endpoint. No message bodies, ever. */
  diagnostics(): Record<string, unknown> {
    return {
      subscribers: this.subscribers.size,
      subscriberAges: [...this.subscribers].map((s) => Math.round((Date.now() - s.attachedAt) / 1000)),
      attachHistory: this.attachHistory.slice(-15),
      watching: this.watching,
      lastPresenceAt: this.lastPresenceAt === 0 ? null : new Date(this.lastPresenceAt).toISOString(),
      head: this.head,
      lastHeadAdvanceAt: this.lastHeadAdvanceAt,
      holds: this.holds,
      routing: this.routingLog.slice(-25),
    }
  }

  /** Comment frame: invisible to EventSource consumers, fatal to dead sockets. */
  private ping(): void {
    for (const sub of [...this.subscribers]) {
      try {
        sub.res.write(": ping\n\n")
      } catch {
        sub.alive = false
        this.subscribers.delete(sub)
      }
    }
  }

  private emit(messages: MeshMessage[]): void {
    const payload = `event: inbox\ndata: ${JSON.stringify({ messages })}\n\n`
    for (const sub of this.subscribers) {
      if (!sub.alive) {
        continue
      }
      try {
        sub.res.write(payload)
      } catch {
        sub.alive = false
        this.subscribers.delete(sub)
      }
    }
  }
}
