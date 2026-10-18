// Tests for `agent-mesh watch` — the canonical inbox watcher.
//
// Two layers:
//   1. cursor-semantics unit checks on local-store's peekWatch/ackWatch
//      (at-least-once: un-acked messages re-deliver; acks are monotonic and
//      clamped; watching never consumes the inbox),
//   2. an end-to-end leg: real daemon + the real `watch` CLI as a subprocess —
//      one `MSG {json}` stdout line per message (backlog included, order kept),
//      `TICK <iso>` lines with --tick, the inbox left unconsumed, and NO
//      message loss across a SIGKILL + restart of the watcher.
//
//   AGENT_MESH_PREFIX=meshtest_w AGENT_MESH_REDIS_URL=redis://localhost:6379 tsx src/test/test-watch.ts

import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { daemonClient } from "../daemon-client.js"
import { getMeshRedis, closeMeshRedis } from "../redis.js"
import { resetMesh } from "../hub.js"
import { ackWatch, appendToInbox, peekWatch, readUnread } from "../local-store.js"
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

function fakeMessage(n: number): MeshMessage {
  return { id: `${n}-0`, ts: new Date().toISOString(), from: "sender", to: "watched", type: "note", body: { n }, correlationId: null, replyTo: null, channel: "test" }
}

// ---- layer 1: cursor semantics (no daemon, isolated AGENT_MESH_HOME) ----

function runCursorChecks(): void {
  console.log(`\n== watch (peek/ack cursor semantics) ==`)
  const home = mkdtempSync(join(tmpdir(), "agent-mesh-watchcur-"))
  const prevHome = process.env.AGENT_MESH_HOME
  process.env.AGENT_MESH_HOME = home
  try {
    const id = "watched"
    appendToInbox(id, fakeMessage(1))
    appendToInbox(id, fakeMessage(2))
    appendToInbox(id, fakeMessage(3))

    // an agent that already consumed its whole inbox via `inbox`: a first watch
    // must NOT replay consumed history (it initializes at the read cursor)
    readUnread(id, { peek: false })
    const afterConsume = peekWatch(id)
    check("first watch peek on a fully-consumed inbox sees nothing", afterConsume.cursor === 3 && afterConsume.messages.length === 0)

    // …but the UNREAD backlog (pending work orders) IS surfaced
    const id2 = "watched-2"
    appendToInbox(id2, fakeMessage(1))
    appendToInbox(id2, fakeMessage(2))
    appendToInbox(id2, fakeMessage(3))
    const first = peekWatch(id2)
    check("first watch peek starts at the read cursor (0) and sees all 3", first.cursor === 0 && first.messages.length === 3)
    check("peeked messages carry absolute 1-based seq tokens", first.messages.map((m) => m.seq).join(",") === "1,2,3")

    // crash between emit and ack: a second peek WITHOUT ack re-delivers
    const again = peekWatch(id2)
    check("un-acked messages re-deliver on the next peek (at-least-once)", again.messages.length === 3)

    ackWatch(id2, 2)
    const afterAck = peekWatch(id2)
    check("ack(2) leaves only seq 3 pending", afterAck.cursor === 2 && afterAck.messages.length === 1 && afterAck.messages[0].seq === 3)

    check("a stale ack can never rewind the cursor (monotonic)", ackWatch(id2, 1).watchCursor === 2)
    check("an ack beyond the inbox clamps to the inbox length", ackWatch(id2, 99).watchCursor === 3)

    // watching never consumes: the inbox read cursor is untouched by all of the above
    const unreadAfterWatch = readUnread(id2, { peek: true })
    check("watch peek/ack never consumes the inbox (all 3 still unread)", unreadAfterWatch.length === 3)

    // and consuming the inbox does not move an established watch cursor
    readUnread(id2, { peek: false })
    check("inbox consume does not move an established watch cursor", peekWatch(id2).cursor === 3)
  } finally {
    if (prevHome != null) {
      process.env.AGENT_MESH_HOME = prevHome
    } else {
      delete process.env.AGENT_MESH_HOME
    }
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- layer 2: end-to-end (daemon + real watch subprocess) ----

function spawnDaemon(home: string, sock: string): ChildProcess {
  const daemon = spawn("tsx", [join(__dirname, "..", "daemon.ts")], {
    env: { ...process.env, AGENT_MESH_HOME: home, AGENT_MESH_SOCK: sock, AGENT_MESH_HOSTNAME: "test-host" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  daemon.stderr?.on("data", (d) => process.env.AGENT_MESH_DEBUG === "1" && process.stderr.write(`[daemon] ${d}`))
  process.env.AGENT_MESH_SOCK = sock
  return daemon
}

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

type WatchProc = { child: ChildProcess; lines: string[] }

function spawnWatch(sock: string, id: string, tickMinutes: string | null): WatchProc {
  const args = [join(__dirname, "..", "cli.ts"), "watch", "--id", id, ...(tickMinutes != null ? ["--tick", tickMinutes] : [])]
  // detached = own process group: tsx runs the script in a CHILD node process,
  // so killing only the tsx parent would orphan the actual watcher (it kept
  // polling and acked the "published while dead" message — flaky test, not a
  // watch bug). killWatch() signals the whole group.
  const child = spawn("tsx", args, {
    env: { ...process.env, AGENT_MESH_SOCK: sock, AGENT_MESH_WATCH_POLL_MS: "100" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  const proc: WatchProc = { child, lines: [] }
  let buf = ""
  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString()
    const parts = buf.split("\n")
    buf = parts.pop() ?? ""
    proc.lines.push(...parts.filter((l) => l !== ""))
  })
  child.stderr?.on("data", (d) => process.env.AGENT_MESH_DEBUG === "1" && process.stderr.write(`[watch] ${d}`))
  return proc
}

function killWatch(proc: WatchProc): void {
  const pid = proc.child.pid
  if (pid != null) {
    try {
      process.kill(-pid, "SIGKILL") // negative pid = the whole process group
      return
    } catch {
      /* group already gone — fall through */
    }
  }
  proc.child.kill("SIGKILL")
}

async function runE2eChecks(): Promise<void> {
  console.log(`\n== watch (end-to-end: daemon + watch subprocess) ==`)
  const admin = await getMeshRedis()
  await resetMesh(admin)
  await closeMeshRedis()

  const home = mkdtempSync(join(tmpdir(), "agent-mesh-watch-"))
  const sock = join(home, "daemon.sock")
  const daemon = spawnDaemon(home, sock)
  let watcher: WatchProc | null = null
  try {
    await waitForSocket(8000)
    await daemonClient.register({ id: "watched", role: "implementer" })
    await daemonClient.register({ id: "sender", role: "orchestrator" })

    // a message published BEFORE the watcher starts = unread backlog
    await daemonClient.publish({ from: "sender", to: "watched", type: "request", body: { n: 0 } })
    await sleep(400) // let the delivery loop land it in the inbox file

    watcher = spawnWatch(sock, "watched", "0.006") // tick every ~360ms
    await sleep(700)
    await daemonClient.publish({ from: "sender", to: "watched", type: "note", body: { n: 1 } })
    await daemonClient.publish({ from: "sender", to: "watched", type: "note", body: { n: 2 } })
    await sleep(900)

    const msgLines = watcher.lines.filter((l) => l.startsWith("MSG "))
    const tickLines = watcher.lines.filter((l) => l.startsWith("TICK "))
    const otherLines = watcher.lines.filter((l) => !l.startsWith("MSG ") && !l.startsWith("TICK "))
    const parsed = msgLines.map((l) => JSON.parse(l.slice(4)) as MeshMessage)
    check("one MSG line per message, backlog included", msgLines.length === 3, `got ${msgLines.length}`)
    check("messages arrive in publish order", parsed.map((m) => m.body.n).join(",") === "0,1,2", parsed.map((m) => m.body.n).join(","))
    check("MSG payloads are complete mesh messages", parsed.every((m) => m.from === "sender" && /^\d+-\d+$/.test(m.id)))
    check("TICK lines interleave with an ISO timestamp", tickLines.length >= 1 && tickLines.every((l) => !Number.isNaN(Date.parse(l.slice(5)))), `got ${tickLines.length}`)
    check("stdout carries ONLY MSG/TICK lines", otherLines.length === 0, otherLines.join(" | "))
    check("watching did NOT consume the inbox", (await daemonClient.inbox("watched", { peek: true })).length === 3)

    // crash + restart: SIGKILL (no cleanup possible), publish while down,
    // restart — nothing lost, nothing acked re-emitted
    killWatch(watcher)
    await sleep(200)
    await daemonClient.publish({ from: "sender", to: "watched", type: "decision", body: { n: 3 } })
    await sleep(400)
    watcher = spawnWatch(sock, "watched", null)
    await sleep(2500) // tsx cold-start + first poll
    const afterRestart = watcher.lines.filter((l) => l.startsWith("MSG ")).map((l) => (JSON.parse(l.slice(4)) as MeshMessage).body.n)
    check("a message published while the watcher was dead is emitted after restart", afterRestart.includes(3), afterRestart.join(","))
    check("already-acked messages are not re-emitted (cursor survived the kill)", !afterRestart.some((n) => n === 0 || n === 1 || n === 2), afterRestart.join(","))
    check("no TICK lines without --tick", watcher.lines.every((l) => !l.startsWith("TICK ")))
  } finally {
    if (watcher != null) {
      killWatch(watcher)
    }
    daemon.kill("SIGTERM")
    await sleep(200)
    rmSync(home, { recursive: true, force: true })
  }
}

export async function runWatchTest(): Promise<number> {
  runCursorChecks()
  await runE2eChecks()
  console.log(`\nwatch: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}
