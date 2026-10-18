// Read-side access to this host's mesh, shared by the dashboard's /api routes and
// the mobile console's chat/voice tools.
//
// Everything here is SIDE-EFFECT FREE by design: inspecting a channel must never
// advance an agent's read cursor, or opening the dashboard would silently consume
// mail the agent has not seen. That is why the local path reads the inbox JSONL
// directly instead of calling the daemon's GET /inbox.

import { existsSync, readFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { getAgentState, getLocalAgents, inboxFile, socketPath } from "./local-store.js"
import type { AgentRecord, MeshMessage } from "./types.js"

// Forward one request to the daemon's unix socket and relay status + body.
export function proxyToDaemon(args: { method: string; path: string; body: string | null }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: socketPath(),
        path: args.path,
        method: args.method,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString() }))
      },
    )
    req.on("error", reject)
    if (args.body != null) {
      req.write(args.body)
    }
    req.end()
  })
}

// Order two Redis stream ids ("<ms>-<seq>") by publish order. Each segment is
// compared numerically: the ms part is fixed-width for our era so it would sort
// lexically too, but seq is not — "<ms>-10" must sort after "<ms>-9", which a
// string compare gets wrong once seq reaches double digits in the same ms.
export function compareStreamIds(a: string, b: string): number {
  const [ams, aseq] = a.split("-")
  const [bms, bseq] = b.split("-")
  return Number(ams) - Number(bms) || Number(aseq ?? 0) - Number(bseq ?? 0)
}

// Full delivered history for a locally-served agent (every line in the durable
// inbox buffer, read + unread alike).
export function readInboxHistory(id: string): MeshMessage[] {
  // inboxFile rejects an id outside the agent-id charset before it names a file.
  const file = inboxFile(id)
  if (!existsSync(file)) {
    return []
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as MeshMessage]
      } catch {
        return [] // skip malformed lines (e.g. a partial write after a crash)
      }
    })
}

// `historyOffset` is the position of `history[0]` in the full inbox. Only a local buffer
// has a read cursor to compare against; everywhere else it is 0 and unused.
export type Inspection = { id: string; source: string; history: MeshMessage[]; readCount: number | null; historyOffset: number }

// Everything delivered to one channel. A locally-served agent has a durable buffer
// that already includes broadcast deliveries AND a read cursor — the richest view,
// so prefer it. For a remote agent the inbox stream alone would MISS broadcasts
// (its own daemon fans those out, they never land in its inbox stream), so they
// are merged back in.
export async function inspect(id: string, limit = 500): Promise<Inspection> {
  if (getLocalAgents()[id] != null) {
    const all = readInboxHistory(id)
    const state = getAgentState(id)
    const history = all.slice(-limit)
    return { id, source: "local-buffer", history, readCount: state.readCount, historyOffset: all.length - history.length }
  }
  const proxied = await proxyToDaemon({ method: "GET", path: `/history?id=${encodeURIComponent(id)}&limit=${limit}`, body: null })
  if (proxied.status === 404) {
    // Daemon predates GET /history — restart it from a checkout with this change.
    return { id, source: "unsupported", history: [], readCount: null, historyOffset: 0 }
  }
  if (proxied.status !== 200) {
    throw new Error(`daemon /history → ${proxied.status}: ${proxied.body}`)
  }
  if (id === "broadcast") {
    return { id, source: "broadcast-stream", history: JSON.parse(proxied.body) as MeshMessage[], readCount: null, historyOffset: 0 }
  }
  const direct = JSON.parse(proxied.body) as MeshMessage[]
  const broadcastRes = await proxyToDaemon({ method: "GET", path: `/history?id=broadcast&limit=${limit}`, body: null })
  const broadcasts = broadcastRes.status === 200 ? (JSON.parse(broadcastRes.body) as MeshMessage[]) : []
  const history = [...direct, ...broadcasts].sort((a, b) => compareStreamIds(a.id, b.id))
  return { id, source: "mesh-stream", history, readCount: null, historyOffset: 0 }
}

export async function listAgents(): Promise<AgentRecord[]> {
  const res = await proxyToDaemon({ method: "GET", path: "/agents", body: null })
  if (res.status !== 200) {
    throw new Error(`daemon /agents → ${res.status}: ${res.body}`)
  }
  return JSON.parse(res.body) as AgentRecord[]
}

export function publishMessage(input: {
  from: string
  to: string
  type: string
  body: Record<string, unknown>
  correlationId: string | null
  replyTo: string | null
}): Promise<{ status: number; body: string }> {
  return proxyToDaemon({ method: "POST", path: "/publish", body: JSON.stringify(input) })
}
