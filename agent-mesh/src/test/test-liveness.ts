// The daemon's liveness sweep + agent-died events, on an ISOLATED
// stack (throwaway Redis prefix + a per-test AGENT_MESH_HOME/SOCK). Drives a real
// daemon subprocess exactly as agents would (through the local socket), with a
// fake long-lived `claude` process standing in for a worker's owning session so
// liveness is decided deterministically by the pid signal (no transcript-timing
// flakiness). Verifies:
//   - live owner            -> roster shows `online`
//   - kill owner -> sweep   -> exactly one online→dead transition + ONE agent-died
//                             event to the orchestrator (body: id, meta, evidence,
//                             last_transcript_growth)
//   - sweep again           -> NO duplicate event (exactly-once, no flapping)
//   - re-register (revived)  -> back to `online`, no new event
//   - roster rendering of all three statuses (online / dead / stale) via the hub
//
//   AGENT_MESH_PREFIX=meshtest AGENT_MESH_REDIS_URL=redis://localhost:6379 tsx src/test/test-liveness.ts

import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { daemonClient } from "../daemon-client.js"
import { getMeshRedis, closeMeshRedis } from "../redis.js"
import { listAgents, registerAgent, resetMesh, setAgentStatus } from "../hub.js"
import { agentsKey } from "../keys.js"
import type { AgentRecord } from "../types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
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

// A fake "owning claude": an executable whose basename is `claude` so the
// liveness probe's pid signal (ps args → isClaudeCommandLine) recognises it.
// Mirrors the live-owner fixture in test-delivery.ts.
function spawnFakeClaude(dir: string, sessionId: string): ChildProcess {
  const claudeBin = join(dir, "claude")
  writeFileSync(claudeBin, `#!/bin/sh\nsleep 120\n`)
  chmodSync(claudeBin, 0o755)
  return spawn(claudeBin, ["--session", sessionId], { stdio: "ignore" })
}

export async function runLivenessSweepTest(): Promise<number> {
  console.log(`\n== daemon (liveness sweep + agent-died events) ==`)
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

  const home = mkdtempSync(join(tmpdir(), "agent-mesh-live-"))
  const sock = join(home, "daemon.sock")
  const workerCwd = join(home, "worker-worktree")
  mkdirSync(workerCwd)
  const sessionId = `sess-live-${process.pid}`
  const owner = spawnFakeClaude(home, sessionId)

  // fast sweep so the test doesn't wait a real minute
  const daemon = spawnDaemon(home, sock, { AGENT_MESH_LIVENESS_SWEEP_MS: "300" })

  try {
    await waitForSocket(8000)
    await sleep(100) // let the fake owner be visible to ps/pgrep

    await daemonClient.register({ id: "orchestrator", role: "orchestrator", meta: { session: "orch-sess" } })
    // worker owned by the fake live claude (pid signal): declares it via the
    // claude-resume transport, exactly as a dormant-capable session would.
    await daemonClient.register({
      id: "worker-a",
      role: "implementer",
      meta: { ticket: "PROJ-4275", session: sessionId },
      deliver: { type: "claude-resume", sessionId, cwd: workerCwd, pid: owner.pid },
    })

    await sleep(700) // > one sweep interval
    check("live owner: worker shows online after a sweep", (await daemonClient.lookup("worker-a"))?.status === "online", `${(await daemonClient.lookup("worker-a"))?.status}`)
    check("no agent-died event while the owner is alive", (await daemonClient.inbox("orchestrator", { peek: true })).length === 0)

    // kill the owning process — next sweep must detect death
    owner.kill("SIGKILL")
    await sleep(900) // generous: pgrep may briefly still see the killed pid

    const dead = await daemonClient.lookup("worker-a")
    check("kill owner: worker transitions to dead", dead?.status === "dead", `status=${dead?.status}`)

    await sleep(300) // let the delivery loop (BLOCK 1000) flush the published note
    const orchInbox = await daemonClient.inbox("orchestrator")
    const diedEvents = orchInbox.filter((m) => m.correlationId === "agent-died")
    check("orchestrator receives exactly one agent-died event", diedEvents.length === 1, `got ${diedEvents.length}`)
    if (diedEvents.length === 1) {
      const e = diedEvents[0]
      const body = e.body as { id?: string; meta?: Record<string, unknown>; last_transcript_growth?: unknown; evidence?: unknown }
      check("agent-died is a note for the dead worker", e.type === "note" && body.id === "worker-a")
      check("agent-died carries the dead worker's ticket meta", (body.meta as { ticket?: string } | undefined)?.ticket === "PROJ-4275")
      check("agent-died carries evidence + last_transcript_growth fields", typeof body.evidence === "string" && "last_transcript_growth" in body)
    }

    // EXACTLY-ONCE: subsequent sweeps must not re-emit
    await sleep(700) // a couple more sweep intervals
    const afterMore = (await daemonClient.inbox("orchestrator")).filter((m) => m.correlationId === "agent-died")
    check("no duplicate agent-died on later sweeps (exactly-once)", afterMore.length === 0, `dupes=${afterMore.length}`)

    // REVIVAL: a re-register with a fresh live owner flips back to online, no event
    const owner2 = spawnFakeClaude(home, sessionId)
    await sleep(100)
    await daemonClient.register({
      id: "worker-a",
      role: "implementer",
      meta: { ticket: "PROJ-4275", session: sessionId },
      deliver: { type: "claude-resume", sessionId, cwd: workerCwd, pid: owner2.pid },
    })
    await sleep(700)
    check("re-register (revived): worker is online again", (await daemonClient.lookup("worker-a"))?.status === "online", `${(await daemonClient.lookup("worker-a"))?.status}`)
    check("revival emits no agent-died event", (await daemonClient.inbox("orchestrator")).filter((m) => m.correlationId === "agent-died").length === 0)
    owner2.kill("SIGKILL")
  } finally {
    owner.kill("SIGKILL")
    daemon.kill("SIGTERM")
    await sleep(200)
    rmSync(home, { recursive: true, force: true })
  }

  // ---- roster rendering of all three statuses (online / dead / stale) ----
  // Driven directly through the hub against the test prefix: insert three records
  // and assert listAgents derives each status correctly (no daemon needed).
  const client = await getMeshRedis()
  await resetMesh(client)
  await registerAgent(client, { id: "ros-online", role: "implementer", host: "h", meta: {} })
  await registerAgent(client, { id: "ros-dead", role: "implementer", host: "h", meta: {} })
  await setAgentStatus(client, { id: "ros-dead", status: "dead" }) // daemon-marked, fresh lastSeen
  await registerAgent(client, { id: "ros-stale", role: "implementer", host: "h", meta: {} })
  // backdate ros-stale's lastSeen so the host looks gone
  const staleRaw = await client.hGet(agentsKey(), "ros-stale")
  const staleRec = JSON.parse(staleRaw ?? "{}") as AgentRecord
  staleRec.lastSeen = new Date(Date.now() - 5 * 60_000).toISOString()
  await client.hSet(agentsKey(), "ros-stale", JSON.stringify(staleRec))

  const roster = await listAgents(client, { staleAfterMs: 60_000 })
  const byId = (id: string) => roster.find((a) => a.id === id)?.status
  check("roster renders online", byId("ros-online") === "online", `${byId("ros-online")}`)
  check("roster renders dead (sticky while host heartbeats)", byId("ros-dead") === "dead", `${byId("ros-dead")}`)
  check("roster renders stale (host heartbeat gone)", byId("ros-stale") === "stale", `${byId("ros-stale")}`)

  // a dead-marked record whose host then stops heartbeating decays to stale —
  // stale (whole host gone) outranks a per-process dead-mark we can no longer trust
  const deadRaw = await client.hGet(agentsKey(), "ros-dead")
  const deadRec = JSON.parse(deadRaw ?? "{}") as AgentRecord
  deadRec.lastSeen = new Date(Date.now() - 5 * 60_000).toISOString()
  await client.hSet(agentsKey(), "ros-dead", JSON.stringify(deadRec))
  check("dead decays to stale once the host stops heartbeating", (await listAgents(client, { staleAfterMs: 60_000 })).find((a) => a.id === "ros-dead")?.status === "stale")
  await closeMeshRedis()

  console.log(`\nliveness: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}
