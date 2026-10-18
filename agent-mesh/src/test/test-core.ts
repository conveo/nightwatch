// Substep test: the core hub library (register/lookup/list, publish/read, thread,
// realtime waitForMessages, status derivation). Run against a real Redis.
//
//   AGENT_MESH_PREFIX=meshtest AGENT_MESH_REDIS_URL=redis://localhost:6379 \
//     tsx src/test/test-core.ts

import { createMeshBlockingClient, getMeshRedis, closeMeshRedis } from "../redis.js"
import { heartbeat, listAgents, lookupAgent, publish, readInbox, readThread, registerAgent, resetMesh, waitForMessages } from "../hub.js"
import { broadcastKey, hostBroadcastKey, inboxKey } from "../keys.js"
import { deriveDefaultAgentId } from "../identity.js"

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  const status = cond ? "PASS" : "FAIL"
  if (!cond) {
    failures++
  }
  console.log(`  [${status}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
}

async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

export async function runCoreTest(): Promise<number> {
  const client = await getMeshRedis()
  const n = await resetMesh(client)
  console.log(`\n== core library ==`)
  console.log(`reset hub (${n} keys cleared), prefix=${process.env.AGENT_MESH_PREFIX ?? "mesh"}\n`)

  console.log("registry:")
  const a = await registerAgent(client, { id: "worker-1", role: "implementer", host: "coder-a", meta: { ticket: "PROJ-4346" } })
  check("registerAgent returns record", a.id === "worker-1" && a.status === "online")
  await registerAgent(client, { id: "orchestrator", role: "orchestrator", host: "laptop", meta: {} })
  const looked = await lookupAgent(client, "worker-1")
  check("lookupAgent finds it", looked?.meta.ticket === "PROJ-4346")
  check("lookupAgent miss returns null", (await lookupAgent(client, "nope")) === null)
  const agents = await listAgents(client)
  check("listAgents returns both, sorted", agents.length === 2 && agents[0].id === "orchestrator")
  const re = await registerAgent(client, { id: "worker-1", role: "implementer", host: "coder-a", meta: { ticket: "PROJ-9999" } })
  check("re-register preserves registeredAt", re.registeredAt === a.registeredAt)
  check("re-register updates meta", re.meta.ticket === "PROJ-9999")

  console.log("\naddressing by agent id:")
  const m1 = await publish(client, { from: "worker-1", to: "orchestrator", type: "blocker", body: { q: "which transport?" }, correlationId: "blk-1" })
  check("publish returns a stream id", /\d+-\d+/.test(m1.id), m1.id)
  check("publish routed to recipient inbox channel", m1.channel === inboxKey("orchestrator"), m1.channel)
  const orchInbox = await readInbox(client, { agentId: "orchestrator" })
  check("recipient sees the message", orchInbox.length === 1 && orchInbox[0].body.q === "which transport?")
  check("non-recipient inbox empty (id-scoped)", (await readInbox(client, { agentId: "worker-1" })).length === 0)
  await publish(client, { from: "orchestrator", to: "worker-1", type: "decision", body: { choice: "redis-streams" }, correlationId: "blk-1", replyTo: m1.id })
  check("reply reaches worker-1", (await readInbox(client, { agentId: "worker-1" }))[0]?.type === "decision")

  console.log("\nreplay / cursor:")
  const since = orchInbox[0].id
  await publish(client, { from: "worker-1", to: "orchestrator", type: "status", body: { progress: 50 } })
  const afterCursor = await readInbox(client, { agentId: "orchestrator", since })
  check("since cursor returns only newer", afterCursor.length === 1 && afterCursor[0].type === "status", `got ${afterCursor.length}`)

  console.log("\nbroadcast:")
  const b = await publish(client, { from: "orchestrator", to: "broadcast", type: "note", body: { msg: "freeze migrations" } })
  check("broadcast routed to broadcast channel", b.channel === broadcastKey(), b.channel)

  console.log("\nhost broadcast:")
  const hb = await publish(client, { from: "orchestrator", to: "host:coder-a", type: "note", body: { msg: "coder-a: rebase on main" } })
  check("host broadcast routed to that host's stream", hb.channel === hostBroadcastKey("coder-a"), hb.channel)
  check("host broadcast is NOT the mesh-wide stream", hb.channel !== broadcastKey())
  check("a different host gets a different stream", hostBroadcastKey("laptop") !== hostBroadcastKey("coder-a"))
  check("malformed host target ('host:bad host') is rejected", await throws(() => publish(client, { from: "orchestrator", to: "host:bad host", type: "note", body: {} })))

  console.log("\nthread:")
  const thread = await readThread(client, { agentId: "worker-1", correlationId: "blk-1" })
  check("thread groups by correlationId", thread.length === 1 && thread[0].type === "decision")

  console.log("\nrealtime (XREAD BLOCK):")
  const blockingClient = await createMeshBlockingClient()
  const waitPromise = waitForMessages(blockingClient, { cursors: { [inboxKey("orchestrator")]: "$" }, blockMs: 3000 })
  await new Promise((r) => setTimeout(r, 150))
  await publish(client, { from: "worker-1", to: "orchestrator", type: "request", body: { action: "review PR 7999" } })
  const delivered = await waitPromise
  check("waitForMessages wakes on new message", delivered.length === 1 && delivered[0].type === "request", `got ${delivered.length}`)
  await blockingClient.close()

  console.log("\nstatus derivation:")
  await heartbeat(client, { id: "worker-1" })
  check("recent heartbeat => online", (await lookupAgent(client, "worker-1", { staleAfterMs: 60_000 }))?.status === "online")
  // staleAfterMs must be BELOW the minimum possible lastSeen age. On a fast host
  // the heartbeat write and this read can land in the same millisecond (age=0), so
  // `staleAfterMs: 0` (`age > 0` => false) made this a same-ms flake. -1 makes
  // "expired window => stale" deterministic while still asserting the same branch.
  check("expired staleness window => stale", (await lookupAgent(client, "worker-1", { staleAfterMs: -1 }))?.status === "stale")

  console.log("\nagent-id validation (path-traversal / key-injection guard):")
  check("rejects id with slash", await throws(() => registerAgent(client, { id: "../evil", role: "x" })))
  check("rejects id with colon", await throws(() => registerAgent(client, { id: "a:b", role: "x" })))
  check("rejects publish to a traversal id", await throws(() => publish(client, { from: "worker-1", to: "../../etc/passwd", type: "note", body: {} })))
  check("accepts a normal id", !(await throws(() => registerAgent(client, { id: "worker-proj-4346.v2", role: "x" }))))
  check("'broadcast' still valid", !(await throws(() => publish(client, { from: "worker-1", to: "broadcast", type: "note", body: {} }))))

  console.log("\nid derivation (CLI default):")
  const prevSession = process.env.CLAUDE_CODE_SESSION_ID
  const prevCodex = process.env.CODEX_THREAD_ID
  const prevExplicit = process.env.AGENT_MESH_NATIVE_SESSION
  delete process.env.AGENT_MESH_NATIVE_SESSION
  process.env.CLAUDE_CODE_SESSION_ID = "deadbeef-0000-4000-8000-000000000000"
  const derived = deriveDefaultAgentId()
  check("auto-derived id ends with session8", derived != null && derived.endsWith(".deadbeef"), derived ?? "null")
  check("auto-derived id matches the safe charset", derived != null && /^[A-Za-z0-9._-]+$/.test(derived))
  delete process.env.CLAUDE_CODE_SESSION_ID
  process.env.CODEX_THREAD_ID = "codex123-0000-4000-8000-000000000000"
  check("Codex derives a native-session id", deriveDefaultAgentId()?.endsWith(".codex123") === true)
  delete process.env.CODEX_THREAD_ID
  check("no session id => no auto-derivation (humans must set an id)", deriveDefaultAgentId() === null)
  if (prevCodex != null) process.env.CODEX_THREAD_ID = prevCodex
  if (prevExplicit != null) process.env.AGENT_MESH_NATIVE_SESSION = prevExplicit
  if (prevSession != null) {
    process.env.CLAUDE_CODE_SESSION_ID = prevSession
  }

  console.log(`\ncore: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  await closeMeshRedis()
  return failures
}
