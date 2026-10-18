// End-to-end test of the daemon: spawns a real daemon subprocess (its own Redis
// connection + Unix-socket API), then drives it exactly as agents would — through
// the local socket, never touching Redis directly. Verifies:
//   - the local HTTP API (register / publish / inbox / agents / lookup / health)
//   - durable inbox catch-up (GET /inbox advances a read cursor)
//   - DIRECT delivery into a process via the `file` transport (deterministic)
//   - live SSE push (GET /subscribe)
//   - claude-resume argv construction (the "message a running claude" path)
//
//   AGENT_MESH_PREFIX=meshtest_d AGENT_MESH_REDIS_URL=redis://localhost:6379 tsx src/test/test-daemon.ts

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { request } from "node:http"
import { daemonClient } from "../daemon-client.js"
import { getMeshRedis, closeMeshRedis } from "../redis.js"
import { publish, resetMesh } from "../hub.js"
import { buildResumeArgv } from "../claude-delivery.js"
import type { MeshMessage } from "../types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++
  }
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForSocket(timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await daemonClient.health()
      return
    } catch {
      await sleep(100)
    }
  }
  throw new Error("daemon socket never came up")
}

// Spawn a real daemon subprocess with an isolated home + socket, and point the
// client at it. Returns the child so the caller can kill it.
function spawnDaemon(home: string, sock: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const daemon = spawn("tsx", [join(__dirname, "..", "daemon.ts")], {
    env: { ...process.env, AGENT_MESH_HOME: home, AGENT_MESH_SOCK: sock, AGENT_MESH_HOSTNAME: "test-host", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  })
  daemon.stderr?.on("data", (d) => process.env.AGENT_MESH_DEBUG === "1" && process.stderr.write(`[daemon] ${d}`))
  daemon.stdout?.on("data", (d) => process.env.AGENT_MESH_DEBUG === "1" && process.stderr.write(`[daemon] ${d}`))
  process.env.AGENT_MESH_SOCK = sock
  return daemon
}

export async function runDaemonTest(): Promise<number> {
  console.log(`\n== daemon (local socket API + direct delivery) ==`)
  // clean redis state for this prefix
  const admin = await getMeshRedis()
  await resetMesh(admin)
  await closeMeshRedis()

  const home = mkdtempSync(join(tmpdir(), "agent-mesh-test-"))
  const sock = join(home, "daemon.sock")
  const deliveredFile = join(home, "worker-a-delivered.jsonl") // stands in for "the running process"

  // fake `claude` for the end-to-end claude-resume leg: records the cwd it ran in
  const resumeLog = join(home, "resume-invocations.log")
  const fakeClaude = join(home, "fake-claude")
  writeFileSync(fakeClaude, `#!/bin/sh\necho "$PWD" >> "${resumeLog}"\n`)
  chmodSync(fakeClaude, 0o755)
  const resumeCwd = join(home, "agent-worktree")
  mkdirSync(resumeCwd)

  const daemon = spawnDaemon(home, sock, { AGENT_MESH_CLAUDE_BIN: fakeClaude, AGENT_MESH_RESUME_DEBOUNCE_MS: "50" })

  try {
    await waitForSocket(8000)
    const health = await daemonClient.health()
    check("daemon health ok", health.ok === true && health.hostname === "test-host")

    // register two agents THROUGH the daemon (no direct redis)
    await daemonClient.register({ id: "orchestrator", role: "orchestrator", meta: { host: "laptop" } })
    await daemonClient.register({ id: "worker-a", role: "implementer", meta: { ticket: "PROJ-1" }, deliver: { type: "file", path: deliveredFile } })
    const agents = await daemonClient.agents()
    check("both agents registered & discoverable", agents.length === 2 && agents.some((a) => a.id === "worker-a"))
    check("lookup returns meta", (await daemonClient.lookup("worker-a"))?.meta.ticket === "PROJ-1")

    // open an SSE subscription for orchestrator and collect pushed messages
    const sseMessages: MeshMessage[] = []
    const sseReq = openSse(sock, "orchestrator", (m) => sseMessages.push(m))
    await sleep(200)

    // worker-a publishes a blocker to orchestrator THROUGH the daemon
    const blocker = await daemonClient.publish({ from: "worker-a", to: "orchestrator", type: "blocker", body: { q: "transport?" }, correlationId: "blk-1" })
    check("publish returns stream id", /\d+-\d+/.test(blocker.id), blocker.id)
    await sleep(400) // let the daemon's delivery loop pick it up (BLOCK_MS=1000, but message lands fast)

    // orchestrator catches up via durable inbox
    const orchInbox = await daemonClient.inbox("orchestrator")
    check("orchestrator inbox has the blocker", orchInbox.length === 1 && orchInbox[0].body.q === "transport?", `len=${orchInbox.length}`)
    check("inbox read advances cursor (now empty)", (await daemonClient.inbox("orchestrator")).length === 0)
    check("SSE live-pushed the blocker", sseMessages.some((m) => m.type === "blocker"), `sse got ${sseMessages.length}`)

    // orchestrator replies; worker-a receives it via DIRECT delivery (file transport)
    await daemonClient.publish({ from: "orchestrator", to: "worker-a", type: "decision", body: { choice: "redis-streams" }, correlationId: "blk-1", replyTo: blocker.id })
    await sleep(500)
    const directDelivered = existsSync(deliveredFile) ? readFileSync(deliveredFile, "utf8").trim().split("\n").filter(Boolean) : []
    check("DIRECT delivery pushed into worker-a's process (file transport)", directDelivered.length === 1, `lines=${directDelivered.length}`)
    if (directDelivered.length === 1) {
      const m = JSON.parse(directDelivered[0]) as MeshMessage
      check("direct-delivered message is the decision", m.type === "decision" && (m.body as { choice?: string }).choice === "redis-streams")
    }
    check("worker-a inbox also has it (durable backstop)", (await daemonClient.inbox("worker-a")).length === 1)

    // regression: an `exec` transport whose command can't spawn (ENOENT) must NOT
    // crash the daemon (missing child.on('error') was an uncaught exception).
    await daemonClient.register({ id: "worker-badexec", role: "x", deliver: { type: "exec", cmd: ["/nonexistent/agent-mesh-xyz"] } })
    await daemonClient.publish({ from: "worker-a", to: "worker-badexec", type: "note", body: { x: 1 } })
    await sleep(400)
    let stillUp = false
    try {
      stillUp = (await daemonClient.health()).ok === true
    } catch {
      stillUp = false
    }
    check("daemon survives a failing exec-transport delivery", stillUp)

    sseReq.destroy()

    // session-takeover detection: same id, different meta.session => flagged;
    // same session re-register => not flagged.
    const r1 = await daemonClient.register({ id: "worker-shared", role: "x", meta: { session: "aaaa1111" } })
    check("first register is not a takeover", r1.sessionTakeover !== true)
    const r2 = await daemonClient.register({ id: "worker-shared", role: "x", meta: { session: "aaaa1111" } })
    check("same-session re-register is not a takeover", r2.sessionTakeover !== true)
    const r2b = await daemonClient.register({ id: "worker-shared", role: "x" })
    check("re-register WITHOUT meta.session is not flagged (ambiguous, not takeover)", r2b.sessionTakeover !== true)
    await daemonClient.register({ id: "worker-shared", role: "x", meta: { session: "aaaa1111" } }) // restore session for the takeover check
    const r3 = await daemonClient.register({ id: "worker-shared", role: "x", meta: { session: "bbbb2222" } })
    check("different-session register IS flagged as takeover", r3.sessionTakeover === true && r3.previousSession === "aaaa1111", `takeover=${r3.sessionTakeover} prev=${r3.previousSession}`)

    // CLI auto-injects meta.session (arms takeover detection on the standard path)
    const cliRun = spawnSync("tsx", [join(__dirname, "..", "cli.ts"), "register", "--id", "worker-cli", "--role", "x"], {
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: "cccc3333-0000-4000-8000-000000000000" },
      encoding: "utf8",
    })
    check("CLI register succeeds", cliRun.status === 0, (cliRun.stderr ?? "").slice(0, 120))
    check("CLI auto-injected meta.session", (await daemonClient.lookup("worker-cli"))?.meta.session === "cccc3333-0000-4000-8000-000000000000")

    // unregister: removes from registry + roster, and the daemon won't resurrect it
    const un = await daemonClient.unregister("worker-a")
    check("unregister reports registry removal", un.removed === true)
    check("unregistered agent gone from roster", !(await daemonClient.agents()).some((a) => a.id === "worker-a"))
    check("lookup after unregister is null", (await daemonClient.lookup("worker-a")) === null)
    const localAgents = JSON.parse(readFileSync(join(home, "local-agents.json"), "utf8")) as Record<string, unknown>
    check("daemon won't resurrect it (local-agents.json cleaned)", localAgents["worker-a"] == null)
    check("its durable inbox buffer is gone", !existsSync(join(home, "inbox", "worker-a.jsonl")))

    // claude-resume argv construction (the "message a running claude session" path)
    const argv = buildResumeArgv("sess-123", blocker)
    check("claude-resume builds `--resume <id> -p <nudge>`", argv[0] === "--resume" && argv[1] === "sess-123" && argv[2] === "-p" && argv[3].includes("agent-mesh inbox"), argv.slice(0, 3).join(" "))

    // CLI publish happy paths against the live daemon (strict-flag counterparts
    // live in test-cli.ts, which runs daemon-less)
    const cliPublish = spawnSync(
      "tsx",
      [join(__dirname, "..", "cli.ts"), "publish", "--id", "worker-cli", "--to", "orchestrator", "--type", "note", "--body", `{"hello":1}`],
      { env: { ...process.env }, encoding: "utf8" },
    )
    check("CLI publish with --body succeeds", cliPublish.status === 0, (cliPublish.stderr ?? "").slice(0, 120))
    const cliPublishEmpty = spawnSync(
      "tsx",
      [join(__dirname, "..", "cli.ts"), "publish", "--id", "worker-cli", "--to", "orchestrator", "--type", "note", "--allow-empty"],
      { env: { ...process.env }, encoding: "utf8" },
    )
    check("CLI publish with --allow-empty permits an empty body", cliPublishEmpty.status === 0, (cliPublishEmpty.stderr ?? "").slice(0, 120))

    // END-TO-END claude-resume leg: a registered DORMANT session gets resumed by
    // the daemon exactly once, in its REGISTERED cwd (not the daemon's own cwd).
    const sessE2e = `sess-e2e-${process.pid}`
    await daemonClient.register({ id: "worker-resume", role: "x", deliver: { type: "claude-resume", sessionId: sessE2e, cwd: resumeCwd } })
    await daemonClient.publish({ from: "orchestrator", to: "worker-resume", type: "note", body: { wake: 1 } })
    await daemonClient.publish({ from: "orchestrator", to: "worker-resume", type: "note", body: { wake: 2 } })
    // the delivery loop's in-flight XREAD (BLOCK 1000) may not watch the
    // just-registered stream yet: worst case ~1s until pickup + 50ms debounce
    await sleep(2500)
    const resumeRuns = existsSync(resumeLog) ? readFileSync(resumeLog, "utf8").trim().split("\n").filter(Boolean) : []
    check("daemon resumed the dormant session exactly once for a 2-message burst", resumeRuns.length === 1, `runs=${resumeRuns.length}`)
    // realpath: the fake claude reports $PWD, which resolves macOS's /var -> /private/var
    check("…in the agent's REGISTERED cwd, not the daemon's", resumeRuns[0] === realpathSync(resumeCwd), resumeRuns[0])
  } finally {
    daemon.kill("SIGTERM")
    await sleep(200)
    rmSync(home, { recursive: true, force: true })
  }

  console.log(`\ndaemon: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}

// Regression for the broadcast-cursor bug: on a FRESH daemon, the first agent to
// register must NOT replay broadcasts that already existed before it joined (the
// daemon-wide broadcast cursor has to be initialized to "now", not left at "0").
export async function runBroadcastCursorTest(): Promise<number> {
  console.log(`\n== daemon (broadcast cursor init on first registration) ==`)
  let failures = 0
  const check = (name: string, cond: boolean, detail = "") => {
    if (!cond) {
      failures++
    }
    console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
  }

  const admin = await getMeshRedis()
  await resetMesh(admin)
  // A broadcast that exists BEFORE any agent/daemon — the new agent must not see it.
  await publish(admin, { from: "system", to: "broadcast", type: "note", body: { msg: "pre-existing-broadcast" } })
  await closeMeshRedis()

  const home = mkdtempSync(join(tmpdir(), "agent-mesh-bc-"))
  const sock = join(home, "daemon.sock")
  const daemon = spawnDaemon(home, sock)
  try {
    await waitForSocket(8000)
    await daemonClient.register({ id: "worker-late", role: "x" })
    await sleep(500)
    const inboxAfterRegister = await daemonClient.inbox("worker-late", { peek: true })
    check("new agent does NOT replay the pre-existing broadcast", inboxAfterRegister.length === 0, `got ${inboxAfterRegister.length}`)

    // a broadcast published AFTER registration should still be delivered.
    await daemonClient.publish({ from: "system", to: "broadcast", type: "note", body: { msg: "fresh-broadcast" } })
    await sleep(500)
    const inboxAfterFresh = await daemonClient.inbox("worker-late")
    check("new agent DOES receive broadcasts sent after it joined", inboxAfterFresh.length === 1 && inboxAfterFresh[0].body.msg === "fresh-broadcast", `got ${inboxAfterFresh.length}`)
  } finally {
    daemon.kill("SIGTERM")
    await sleep(200)
    rmSync(home, { recursive: true, force: true })
  }
  console.log(`\nbroadcast-cursor: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}

// Host-scoped fan-out (`--to host:<hostname>`): a message addressed to THIS
// daemon's host reaches every local agent; one addressed to another host reaches
// none (only the owning host's daemon tails that stream). And — like the
// mesh-wide broadcast — a freshly-registered agent must not replay a host
// broadcast that predates it (host cursor initialized to "now").
export async function runHostBroadcastTest(): Promise<number> {
  console.log(`\n== daemon (host broadcast) ==`)
  let failures = 0
  const check = (name: string, cond: boolean, detail = "") => {
    if (!cond) {
      failures++
    }
    console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
  }

  const admin = await getMeshRedis()
  await resetMesh(admin)
  // A host broadcast that exists BEFORE any agent joins — the late agent must not see it.
  await publish(admin, { from: "system", to: "host:test-host", type: "note", body: { msg: "pre-existing-host" } })
  await closeMeshRedis()

  const home = mkdtempSync(join(tmpdir(), "agent-mesh-hb-"))
  const sock = join(home, "daemon.sock")
  const daemon = spawnDaemon(home, sock) // AGENT_MESH_HOSTNAME=test-host
  try {
    await waitForSocket(8000)
    await daemonClient.register({ id: "host-a", role: "x" })
    await daemonClient.register({ id: "host-b", role: "x" })
    await sleep(500)
    check("late agent does NOT replay a pre-existing host broadcast", (await daemonClient.inbox("host-a", { peek: true })).length === 0)

    // host broadcast to THIS host → every local agent gets it
    await daemonClient.publish({ from: "system", to: "host:test-host", type: "note", body: { msg: "rebase-now" } })
    await sleep(600)
    const aInbox = await daemonClient.inbox("host-a")
    const bInbox = await daemonClient.inbox("host-b")
    check("host broadcast reached agent A", aInbox.length === 1 && aInbox[0].body.msg === "rebase-now", `a=${aInbox.length}`)
    check("host broadcast reached agent B", bInbox.length === 1 && bInbox[0].body.msg === "rebase-now", `b=${bInbox.length}`)

    // host broadcast to a DIFFERENT host → nobody here gets it
    await daemonClient.publish({ from: "system", to: "host:other-host", type: "note", body: { msg: "not-for-us" } })
    await sleep(600)
    check(
      "host broadcast for another host is NOT delivered here",
      (await daemonClient.inbox("host-a")).length === 0 && (await daemonClient.inbox("host-b")).length === 0,
    )
  } finally {
    daemon.kill("SIGTERM")
    await sleep(200)
    rmSync(home, { recursive: true, force: true })
  }
  console.log(`\nhost-broadcast: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}

// Regression: only one daemon may run per host. A second daemon pointed at the
// same home/socket must detect the lock and exit instead of double-delivering.
export async function runSingletonTest(): Promise<number> {
  console.log(`\n== daemon (single-instance lock) ==`)
  let failures = 0
  const check = (name: string, cond: boolean, detail = "") => {
    if (!cond) {
      failures++
    }
    console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
  }

  const home = mkdtempSync(join(tmpdir(), "agent-mesh-lock-"))
  const sock = join(home, "daemon.sock")
  const d1 = spawnDaemon(home, sock)
  try {
    await waitForSocket(8000)
    const d2 = spawnDaemon(home, sock) // same home/sock → should refuse to run
    const d2exit = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 6000)
      d2.on("exit", (code) => {
        clearTimeout(t)
        resolve(code)
      })
    })
    check("second daemon exits instead of double-running", d2exit === 0, `exit=${d2exit}`)
    let up = false
    try {
      up = (await daemonClient.health()).ok === true
    } catch {
      up = false
    }
    check("first daemon still healthy after the duplicate bailed", up)
  } finally {
    d1.kill("SIGTERM")
    await sleep(200)
    rmSync(home, { recursive: true, force: true })
  }
  console.log(`\nsingleton: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}

// local-agents.json is read back on restart without going through /register, so
// an id written there by hand (or by an older build) must not be served: the
// daemon derives the actor's inbox path from it.
export async function runRestoreValidationTest(): Promise<number> {
  console.log(`\n== daemon restore skips persisted ids outside the agent-id charset ==`)
  let failures = 0
  const check = (name: string, cond: boolean, detail = "") => {
    if (!cond) {
      failures++
    }
    console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
  }
  const admin = await getMeshRedis()
  await resetMesh(admin)
  await closeMeshRedis()
  const home = mkdtempSync(join(tmpdir(), "agent-mesh-restore-"))
  const sock = join(home, "daemon.sock")
  mkdirSync(join(home, "inbox"), { recursive: true })
  const persisted = {
    "../escaped": { id: "../escaped", role: "x", meta: {}, deliver: { type: "sse" } },
    "restored-ok": { id: "restored-ok", role: "x", meta: {}, deliver: { type: "sse" } },
  }
  writeFileSync(join(home, "local-agents.json"), JSON.stringify(persisted))
  const daemon = spawnDaemon(home, sock)
  try {
    await waitForSocket(8000)
    const local = (await daemonClient.health()).localAgents ?? []
    check("a valid persisted actor is restored", local.includes("restored-ok"), JSON.stringify(local))
    check("a persisted id with a path separator is not restored", !local.includes("../escaped"), JSON.stringify(local))
    await daemonClient.publish({ from: "restored-ok", to: "restored-ok", type: "note", body: { probe: 1 }, correlationId: null })
    await sleep(500)
    check("nothing was written outside the inbox directory", !existsSync(join(home, "escaped.jsonl")))
  } finally {
    daemon.kill("SIGTERM")
    await sleep(200)
    rmSync(home, { recursive: true, force: true })
  }
  console.log(`\nrestore validation: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}

function openSse(sock: string, id: string, onMessage: (m: MeshMessage) => void) {
  const req = request({ socketPath: sock, path: `/subscribe?id=${id}`, method: "GET" }, (res) => {
    res.setEncoding("utf8")
    let buf = ""
    res.on("data", (chunk) => {
      buf += chunk
      const events = buf.split("\n\n")
      buf = events.pop() ?? ""
      for (const ev of events) {
        const dataLine = ev.split("\n").find((l) => l.startsWith("data: "))
        const eventLine = ev.split("\n").find((l) => l.startsWith("event: "))
        if (dataLine != null && eventLine?.includes("message") === true) {
          onMessage(JSON.parse(dataLine.slice(6)) as MeshMessage)
        }
      }
    })
  })
  req.on("error", () => {})
  req.end()
  return req
}
