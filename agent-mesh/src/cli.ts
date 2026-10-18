// agent-mesh CLI — what an agent (or a human) uses. A thin client of the local
// daemon socket; it never connects to Redis itself.
//
//   agent-mesh <command> [flags]      (dev: tsx src/cli.ts <command>)
//
// Commands:
//   whoami                          print this agent's id (AGENT_MESH_ID)
//   register --role R [--meta k=v]  register this agent with the local daemon
//                                   [--deliver sse|claude-resume:SESSION|fifo:PATH|file:PATH|exec:CMD]
//   publish --to ID --type T --body '{...}' [--corr ID] [--reply ID] [--allow-empty]
//                                   --to is an agent id, 'broadcast' (mesh-wide,
//                                   rarely right), or 'host:<hostname>' (everyone
//                                   on one host — the usual fan-out)
//   inbox [--peek]                  read (and consume) this agent's new messages
//   watch [--tick MIN]              run forever, emitting one stdout line per new
//                                   inbox message (`MSG {json}`) — peek + ack only
//                                   AFTER the line is out, never consuming the
//                                   inbox; --tick interleaves `TICK <iso>` lines.
//                                   Meant to run under a harness Monitor.
//   unregister                      remove this agent from the mesh (registry +
//                                   inbox deleted; the daemon won't resurrect it)
//   agents                          list all registered agents (across hosts)
//   lookup --id ID                  show one agent's record
//   subscribe [--id ID]             live-stream messages (SSE) for an agent
//   health                          daemon status
//
// Agent id resolution: --id flag > AGENT_MESH_ID env.
//
// STRICT by design: unknown flags and stray positional arguments are
// errors, not no-ops — a typo'd flag once silently dropped a whole payload.

import { readFileSync } from "node:fs"
import { discoverSuperset, supersetNativeSession } from "./superset-delivery.js"
import { ownerSchema, endpointSchema, processStarted, runCommand } from "./managed-delivery.js"
import { request } from "node:http"
import { call, daemonClient, type DeliverTransportInput } from "./daemon-client.js"
import { formatAgentLine, formatInboxLine } from "./cli-format.js"
import { deriveDefaultAgentId } from "./identity.js"
import { cwdOfPid, findOwningClaudePid, findOwningRuntimePid } from "./process-utils.js"
import { socketPath } from "./local-store.js"

type Flags = Record<string, string | boolean>

function parseFlags(argv: string[]): { _: string[]; flags: Flags } {
  const _: string[] = []
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next == null || next.startsWith("--")) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else {
      _.push(a)
    }
  }
  return { _, flags }
}

// Every flag a command accepts. Anything else is rejected loudly — the wave-1
// incident published with `--json <payload>` instead of `--body <payload>` and
// the payload was silently dropped (7 empty messages before anyone noticed).
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  whoami: ["id", "native-session"],
  health: [],
  register: ["id", "role", "meta", "deliver", "binding", "runtime", "native-session", "monitor", "dedicated", "tick"],
  rebind: ["id", "role", "meta", "generation", "binding", "runtime", "native-session", "monitor", "dedicated", "tick"],
  delivery: ["id"],
  receive: ["id", "generation"],
  receipt: ["id", "generation", "token"],
  retry: ["id", "generation", "token"],
  retire: ["id", "generation"],
  publish: ["id", "to", "type", "body", "corr", "reply", "allow-empty"],
  inbox: ["id", "peek"],
  watch: ["id", "tick"],
  unregister: ["id"],
  agents: [],
  lookup: ["id"],
  subscribe: ["id"],
}

// Flags that take no value (presence = true).
const BOOLEAN_FLAGS = new Set(["peek", "allow-empty", "monitor", "dedicated"])

function rejectUnknownArgs(cmd: string, positional: string[], flags: Flags): void {
  const allowed = COMMAND_FLAGS[cmd]
  const valid = allowed.length > 0 ? `valid flags for '${cmd}': ${allowed.map((f) => `--${f}`).join(" ")}` : `'${cmd}' takes no flags`
  if (positional.length > 0) {
    fail(`unexpected argument${positional.length > 1 ? "s" : ""} ${positional.map((a) => `'${a}'`).join(", ")} — ${valid}`)
  }
  const unknown = Object.keys(flags).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) {
    fail(`unknown flag${unknown.length > 1 ? "s" : ""} ${unknown.map((f) => `--${f}`).join(", ")} — ${valid}`)
  }
  for (const [key, value] of Object.entries(flags)) {
    if (BOOLEAN_FLAGS.has(key) && typeof value === "string") {
      fail(`--${key} takes no value (got '${value}')`)
    }
    if (!BOOLEAN_FLAGS.has(key) && value === true) {
      fail(`--${key} requires a value`)
    }
  }
}

function selfId(flags: Flags): string {
  const id = (flags.id as string) ?? process.env.AGENT_MESH_ID ?? deriveDefaultAgentId()
  if (id == null || id === "") {
    fail(
      "no agent id — set AGENT_MESH_ID or pass --id (auto-derivation needs CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, or --native-session)",
    )
  }
  return id
}

function fail(msg: string): never {
  process.stderr.write(`agent-mesh: ${msg}\n`)
  process.exit(1)
}

function parseMeta(flags: Flags): Record<string, unknown> {
  const raw = flags.meta
  if (typeof raw !== "string") {
    return {}
  }
  const out: Record<string, unknown> = {}
  for (const pair of raw.split(",")) {
    const [k, ...v] = pair.split("=")
    if (k !== "") {
      out[k] = v.join("=")
    }
  }
  return out
}

function parseDeliver(flags: Flags): DeliverTransportInput | undefined {
  const raw = flags.deliver
  if (typeof raw !== "string") {
    return undefined
  }
  if (raw === "sse" || raw === "none") {
    return { type: raw }
  }
  const [type, ...rest] = raw.split(":")
  const arg = rest.join(":")
  if (type === "claude-resume") {
    // Capture where + by-whom the session runs NOW: a dormant-session resume
    // must run in this cwd (never the daemon's), and the owning claude pid lets
    // the daemon skip the resume while this session is still alive.
    // cwd resolution: explicit env override > the owning claude process's REAL
    // cwd (process.cwd() lies under `pnpm --dir agent-mesh exec`) > our own cwd.
    const pid = findOwningClaudePid()
    const cwd = process.env.AGENT_MESH_CALLER_CWD ?? (pid != null ? cwdOfPid(pid) : null) ?? process.cwd()
    return { type, sessionId: arg, cwd, ...(pid != null ? { pid } : {}) }
  }
  if (type === "fifo" || type === "file") {
    return { type, path: arg }
  }
  if (type === "exec") {
    return { type, cmd: arg.split(" ") }
  }
  fail(`bad --deliver '${raw}' (use sse | claude-resume:SESSION | fifo:PATH | file:PATH | exec:CMD)`)
}

// publish refuses an empty body unless that's explicit: an empty `{}` usually
// means the payload flag was mistyped or the shell ate the value — exactly the
// silent loss this CLI is now strict about.
function parsePublishBody(flags: Flags): Record<string, unknown> {
  const raw = flags.body
  let body: Record<string, unknown> = {}
  if (raw === true) {
    fail('--body requires a value, e.g. --body \'{"k":"v"}\'')
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      fail(`--body is not valid JSON (${(e as Error).message}): ${raw.slice(0, 80)}`)
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`--body must be a JSON object like '{"k":"v"}', got: ${raw.slice(0, 80)}`)
    }
    body = parsed as Record<string, unknown>
  }
  if (Object.keys(body).length === 0 && flags["allow-empty"] !== true) {
    fail(
      "refusing to publish an empty body (missing/empty --body usually means the payload was lost to a typo). Pass --body '{...}' or, if an empty body is intentional, add --allow-empty.",
    )
  }
  return body
}

async function main() {
  const [, , cmd, ...rest] = process.argv
  const { _: positional, flags } = parseFlags(rest)
  if (cmd != null && COMMAND_FLAGS[cmd] != null) {
    rejectUnknownArgs(cmd, positional, flags)
  }

  if (typeof flags["native-session"] === "string") process.env.AGENT_MESH_NATIVE_SESSION = flags["native-session"]
  if (
    !["health", "agents", "lookup"].includes(cmd ?? "") &&
    process.env.AGENT_MESH_NATIVE_SESSION == null &&
    process.env.CLAUDE_CODE_SESSION_ID == null &&
    process.env.CODEX_THREAD_ID == null &&
    process.env.SUPERSET_WORKSPACE_ID != null &&
    process.env.SUPERSET_TERMINAL_ID != null
  ) {
    for (const runtime of ["claude", "codex"] as const) {
      if (flags.runtime != null && flags.runtime !== runtime) continue
      const pid = findOwningRuntimePid(runtime)
      if (pid == null) continue
      const detected = await discoverSuperset({ env: process.env, run: runCommand })
      if (detected.endpoint == null) break
      const session = await supersetNativeSession({ endpoint: detected.endpoint, runtime, pid, run: runCommand })
      if (session != null) process.env[runtime === "claude" ? "CLAUDE_CODE_SESSION_ID" : "CODEX_THREAD_ID"] = session
      break
    }
  }
  if (cmd === "rebind" || (cmd === "register" && flags.deliver === "auto")) {
    if (flags.runtime == null && process.env.CODEX_THREAD_ID != null && process.env.CLAUDE_CODE_SESSION_ID != null)
      fail("both runtime identities present; pass --runtime explicitly")
    const runtime =
      flags.runtime ?? (process.env.CODEX_THREAD_ID != null ? "codex" : process.env.CLAUDE_CODE_SESSION_ID != null ? "claude" : null)
    if (runtime != null && runtime !== "claude" && runtime !== "codex") fail("--runtime must be claude or codex")
    const session =
      process.env.AGENT_MESH_NATIVE_SESSION ?? (runtime === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_CODE_SESSION_ID)
    if (session != null) process.env.AGENT_MESH_NATIVE_SESSION = session
    const pid = runtime == null ? null : findOwningRuntimePid(runtime)
    const started = pid == null ? null : processStarted(pid)
    const owner = session == null || pid == null || started == null ? null : ownerSchema.parse({ runtime, session, pid, started })
    const endpoint = typeof flags.binding === "string" ? endpointSchema.parse(JSON.parse(readFileSync(flags.binding, "utf8"))) : null
    const hints = Object.fromEntries(
      ["SUPERSET_WORKSPACE_ID", "SUPERSET_TERMINAL_ID", "SUPERSET_TAB_ID", "HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"].flatMap(
        (key) => (process.env[key] == null ? [] : [[key, process.env[key]!]]),
      ),
    )
    const result = await call("POST", "/bind", {
      id: selfId(flags),
      role: flags.role ?? fail("--role required"),
      owner,
      meta: parseMeta(flags),
      endpoint,
      hints,
      monitor: flags.monitor === true,
      dedicated: flags.dedicated === true,
      expectedGeneration: cmd === "rebind" ? (flags.generation ?? fail("--generation required")) : null,
      tickMs: parseTickMs(flags),
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }
  switch (cmd) {
    case "delivery": {
      console.log(JSON.stringify(await call("GET", `/delivery?id=${encodeURIComponent(selfId(flags))}`), null, 2))
      return
    }
    case "receive": {
      const generation = flags.generation ?? fail("--generation required (from delivery status or notification)")
      console.log(
        JSON.stringify(
          await call("GET", `/receive?id=${encodeURIComponent(selfId(flags))}&generation=${encodeURIComponent(String(generation))}`),
          null,
          2,
        ),
      )
      return
    }
    case "receipt":
    case "retry":
    case "retire": {
      const generation = flags.generation ?? fail("--generation required")
      const token = cmd === "retire" ? undefined : (flags.token ?? fail("--token required"))
      console.log(JSON.stringify(await call("POST", `/${cmd}`, { id: selfId(flags), generation, token }), null, 2))
      return
    }
    case "whoami": {
      process.stdout.write(`${selfId(flags)}\n`)
      return
    }
    case "health": {
      console.log(JSON.stringify(await daemonClient.health(), null, 2))
      return
    }
    case "register": {
      const id = selfId(flags)
      const role = (flags.role as string) ?? fail("--role required")
      for (const flag of ["binding", "monitor", "dedicated", "tick"]) if (flags[flag] != null) fail(`--${flag} requires --deliver auto`)
      const meta = parseMeta(flags)
      // Always carry the session identity when we have one: it makes this agent
      // discoverable/resumable via lookup AND arms the daemon's takeover
      // detection — without it, an --id override stealing another session's
      // inbox would succeed silently.
      const runtime =
        flags.runtime ?? (process.env.CLAUDE_CODE_SESSION_ID != null ? "claude" : process.env.CODEX_THREAD_ID != null ? "codex" : null)
      if (runtime != null && runtime !== "claude" && runtime !== "codex") fail("--runtime must be claude or codex")
      const native =
        process.env.AGENT_MESH_NATIVE_SESSION ?? (runtime === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_CODE_SESSION_ID)
      if (meta.session == null && native != null) meta.session = native
      if (runtime != null) meta.runtime = runtime
      if (runtime === "codex" && String(flags.deliver).startsWith("claude-resume:")) fail("Codex revival is unsupported")
      // Capture the owning claude pid too: the daemon's liveness sweep
      // uses it as the robust death signal — pid gone → the worker is dead — even
      // for poll-only agents that declare no claude-resume transport. Without it
      // the sweep can only fall back to transcript-idle heuristics, which can't
      // tell an idle-but-alive session from a dead one.
      if (meta.pid == null) {
        const owningPid = meta.runtime === "codex" ? findOwningRuntimePid("codex") : findOwningClaudePid()
        if (owningPid != null) {
          meta.pid = String(owningPid)
        }
      }
      const out = await daemonClient.register({ id, role, meta, deliver: parseDeliver(flags) })
      console.log(`registered ${out.id} (${out.role})`)
      if (out.sessionTakeover === true) {
        console.log(
          `⚠️  session takeover: this id was registered by a different session (${out.previousSession ?? "unknown"}) — its wake-ups now route to YOU. If that wasn't intended, unregister and re-derive a unique id (worktree.host.session8).`,
        )
      }
      return
    }
    case "publish": {
      const from = selfId(flags)
      const to = (flags.to as string) ?? fail("--to required")
      const type = (flags.type as string) ?? fail("--type required")
      const body = parsePublishBody(flags)
      const msg = await daemonClient.publish({
        from,
        to,
        type,
        body,
        correlationId: typeof flags.corr === "string" ? flags.corr : null,
        replyTo: typeof flags.reply === "string" ? flags.reply : null,
      })
      console.log(`published ${msg.id} -> ${to} (${type})`)
      return
    }
    case "inbox": {
      const id = selfId(flags)
      const msgs = await daemonClient.inbox(id, { peek: flags.peek === true })
      if (msgs.length === 0) {
        console.log("(no new messages)")
        return
      }
      for (const m of msgs) {
        console.log(formatInboxLine(m))
      }
      return
    }
    case "watch": {
      await watch(selfId(flags), parseTickMs(flags))
      return
    }
    case "unregister": {
      const id = selfId(flags)
      const out = await daemonClient.unregister(id)
      console.log(
        `unregistered ${id} (registry entry ${out.removed ? "removed" : "was already gone"}; inbox deleted; this daemon will not resurrect it)`,
      )
      return
    }
    case "agents": {
      for (const a of await daemonClient.agents()) {
        console.log(formatAgentLine(a))
      }
      return
    }
    case "lookup": {
      const id = (flags.id as string) ?? fail("--id required")
      console.log(JSON.stringify(await daemonClient.lookup(id), null, 2))
      return
    }
    case "subscribe": {
      subscribe(selfId(flags))
      return
    }
    default:
      fail(
        `unknown command '${cmd ?? ""}'. Try: whoami register rebind delivery receive receipt retry retire unregister publish inbox watch agents lookup subscribe health`,
      )
  }
}

// ---- watch: the canonical inbox watcher ----
//
// Run this under a harness Monitor: every stdout line is a wake event. stdout
// carries EXACTLY two line shapes — `MSG {json}` (one per new inbox message)
// and `TICK <iso>` (with --tick, a clock for elapsed-time rules) — diagnostics
// go to stderr. Delivery is AT-LEAST-ONCE by construction: each message is
// PEEKED, written to stdout, flushed, and only then acked (the daemon's watch
// cursor advances monotonically). A crash anywhere in between re-emits the
// message on restart; nothing is ever consumed unseen — the inbox itself stays
// untouched for `agent-mesh inbox`. (The hand-rolled watchers this replaces
// used consuming reads piped nowhere: a fleet-wide broadcast was eaten unseen.)

function parseTickMs(flags: Flags): number | null {
  const raw = flags.tick
  if (typeof raw !== "string") {
    return null
  }
  const minutes = Number(raw)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    fail(`--tick must be a positive number of minutes, got '${raw}'`)
  }
  return minutes * 60_000
}

// Write one line and resolve only when it's flushed — an ack must never race
// ahead of the bytes the reader wakes on.
function writeLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, (err) => (err != null ? reject(err) : resolve()))
  })
}

// Emit one stdout line, exiting on a closed stdout (the watch reader is gone —
// keep ticking/retrying into the void and the harness never notices). The
// EPIPE check lives HERE, scoped to the stdout write: the daemon's unix socket
// can also throw EPIPE (daemon crash mid-request), and that one must stay
// retryable — it reaches the watch loop's catch as a daemon error instead.
async function emitLineOrExit(line: string): Promise<void> {
  try {
    await writeLine(line)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPIPE") {
      fail("stdout closed — the watch reader is gone")
    }
    throw e
  }
}

async function watch(id: string, tickMs: number | null): Promise<never> {
  const pollMs = Number(process.env.AGENT_MESH_WATCH_POLL_MS ?? "1000")
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // EPIPE surfaces through the write callback below; without a listener the
  // stream ALSO emits 'error' and crashes the process before we can report it.
  process.stdout.on("error", () => {})
  process.stderr.write(
    `agent-mesh: watching inbox of ${id} (poll ${pollMs}ms${tickMs != null ? `, tick ${tickMs / 60_000}min` : ""}; stdout = MSG/TICK lines only)\n`,
  )
  let generation: string | undefined
  let pinned = false
  let nextTick = tickMs == null ? null : Date.now() + tickMs
  let failureStreak = 0
  while (true) {
    try {
      const { messages, generation: currentGeneration } = await daemonClient.watchPeek(id)
      if (!pinned) {
        generation = currentGeneration
        pinned = true
      }
      if (currentGeneration !== generation) fail("watch binding changed; stop the old Monitor")
      for (const { seq, message } of messages) {
        await emitLineOrExit(`MSG ${JSON.stringify(message)}`)
        await daemonClient.watchAck({ id, upTo: seq, generation })
      }
      if (tickMs != null && nextTick != null && Date.now() >= nextTick) {
        await emitLineOrExit(`TICK ${new Date().toISOString()}`)
        nextTick = Date.now() + tickMs
      }
      failureStreak = 0
    } catch (e) {
      // daemon restarting/unreachable (including a mid-request socket EPIPE):
      // keep watching — a watcher that dies silently recreates the clock-less
      // orchestrator failure. Back off, say so on stderr. The cursor is
      // durable, and un-acked messages re-emit; nothing is lost while we wait.
      failureStreak++
      process.stderr.write(`agent-mesh: watch: ${(e as Error).message} (attempt ${failureStreak}; retrying)\n`)
      await sleep(Math.min(pollMs * 2 ** Math.min(failureStreak, 5), 30_000))
      continue
    }
    await sleep(pollMs)
  }
}

// Live SSE stream from the daemon (stays open, prints messages as they arrive).
function subscribe(id: string): void {
  const req = request({ socketPath: socketPath(), path: `/subscribe?id=${encodeURIComponent(id)}`, method: "GET" }, (res) => {
    process.stdout.write(`subscribed to ${id} (live)\n`)
    res.setEncoding("utf8")
    let buf = ""
    res.on("data", (chunk) => {
      buf += chunk
      const events = buf.split("\n\n")
      buf = events.pop() ?? ""
      for (const ev of events) {
        const dataLine = ev.split("\n").find((l) => l.startsWith("data: "))
        if (dataLine != null) {
          console.log(dataLine.slice(6))
        }
      }
    })
  })
  req.on("error", (e) => fail(`cannot subscribe: ${e.message}`))
  req.end()
}

main().catch((e) => fail((e as Error).message))
