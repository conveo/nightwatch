// Core agent-mesh operations over a Redis client. Pure-ish: every function takes
// the client explicitly and returns data — no module-level state, no logging —
// so they're trivial to test with a throwaway client.
//
// Addressing model: a message is XADD'd to the RECIPIENT's stream — an agent's
// inbox (`mesh:inbox:<to>`), one host's fan-out (`mesh:host:<host>:broadcast`), or
// the mesh-wide `mesh:broadcast`. The sender never needs the recipient online; the
// stream is durable, so the message waits until the recipient's daemon reads it.

import { agentsKey, broadcastKey, hostBroadcastKey, inboxKey } from "./keys.js"
import type { MeshRedis } from "./redis.js"
import {
  type AgentRecord,
  BROADCAST,
  hostTarget,
  type MeshMessage,
  type PublishInput,
  publishInputSchema,
  type RegisterInput,
  registerInputSchema,
  type StreamFields,
} from "./types.js"

const DEFAULT_STALE_AFTER_MS = 60_000
const DEFAULT_MAXLEN = 10_000

function nowIso(): string {
  return new Date().toISOString()
}

// ---- agent registry / discovery ----

export async function registerAgent(client: MeshRedis, input: RegisterInput): Promise<AgentRecord> {
  const parsed = registerInputSchema.parse(input)
  const existingRaw = await client.hGet(agentsKey(), parsed.id)
  const now = nowIso()
  const record: AgentRecord = {
    id: parsed.id,
    role: parsed.role,
    host: parsed.host,
    meta: parsed.meta,
    status: "online",
    registeredAt: existingRaw != null ? (JSON.parse(existingRaw) as AgentRecord).registeredAt : now,
    lastSeen: now,
  }
  await client.hSet(agentsKey(), parsed.id, JSON.stringify(record))
  return record
}

export async function heartbeat(client: MeshRedis, args: { id: string; status?: AgentRecord["status"] }): Promise<AgentRecord | null> {
  const raw = await client.hGet(agentsKey(), args.id)
  if (raw == null) {
    return null
  }
  const record = JSON.parse(raw) as AgentRecord
  record.lastSeen = nowIso()
  record.status = args.status ?? "online"
  await client.hSet(agentsKey(), args.id, JSON.stringify(record))
  return record
}

// Derive status from lastSeen at read time, so a crashed daemon shows as stale
// without anyone having to write "offline".
//
//   - offline is explicit and sticky.
//   - no recent host heartbeat (age > staleAfterMs) => stale: the whole daemon is
//     gone, so we can't trust any per-process status it last wrote.
//   - host IS heartbeating => trust the explicitly written status: "dead" (the
//     daemon's liveness sweep found the owning process gone) is sticky;
//     anything else is a live, online agent.
function withDerivedStatus(record: AgentRecord, staleAfterMs: number): AgentRecord {
  if (record.status === "offline") {
    return record
  }
  const age = Date.now() - new Date(record.lastSeen).getTime()
  if (age > staleAfterMs) {
    return { ...record, status: "stale" }
  }
  return { ...record, status: record.status === "dead" ? "dead" : "online" }
}

export async function listAgents(client: MeshRedis, opts: { staleAfterMs?: number } = {}): Promise<AgentRecord[]> {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const all = await client.hGetAll(agentsKey())
  return Object.values(all)
    .map((v) => withDerivedStatus(JSON.parse(v) as AgentRecord, staleAfterMs))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export async function lookupAgent(client: MeshRedis, id: string, opts: { staleAfterMs?: number } = {}): Promise<AgentRecord | null> {
  const raw = await client.hGet(agentsKey(), id)
  if (raw == null) {
    return null
  }
  return withDerivedStatus(JSON.parse(raw) as AgentRecord, opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)
}

export async function setAgentStatus(client: MeshRedis, args: { id: string; status: AgentRecord["status"] }): Promise<AgentRecord | null> {
  return heartbeat(client, args)
}

// Remove an agent from the mesh: delete its registry entry AND its inbox stream
// (any unread messages are gone — callers should drain first if they care).
// Mesh-wide effect; the caller's daemon must also forget the agent locally or it
// will re-register it on restart (the daemon's /unregister endpoint does both).
export async function unregisterAgent(client: MeshRedis, args: { id: string }): Promise<{ removed: boolean }> {
  const removed = await client.hDel(agentsKey(), args.id)
  await client.del(inboxKey(args.id))
  return { removed: removed > 0 }
}

// ---- publishing ----

// Map a publish recipient to its Redis stream: a host target ("host:<hostname>")
// → that host's fan-out stream, "broadcast" → the mesh-wide stream, any other id
// → that agent's inbox.
function channelForRecipient(to: string): string {
  const host = hostTarget(to)
  if (host != null) {
    return hostBroadcastKey(host)
  }
  return to === BROADCAST ? broadcastKey() : inboxKey(to)
}

export async function publish(client: MeshRedis, input: PublishInput): Promise<MeshMessage> {
  const parsed = publishInputSchema.parse(input)
  const ts = nowIso()
  const fields: StreamFields = {
    ts,
    from: parsed.from,
    to: parsed.to,
    type: parsed.type,
    body: JSON.stringify(parsed.body),
    correlationId: parsed.correlationId ?? "",
    replyTo: parsed.replyTo ?? "",
  }
  const channel = channelForRecipient(parsed.to)
  const id = await client.xAdd(channel, "*", fields as unknown as Record<string, string>, {
    TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: DEFAULT_MAXLEN },
  })
  return {
    id,
    ts,
    from: parsed.from,
    to: parsed.to,
    type: parsed.type,
    body: parsed.body,
    correlationId: parsed.correlationId ?? null,
    replyTo: parsed.replyTo ?? null,
    channel,
  }
}

// ---- reading ----

function parseEntry(channel: string, entry: { id: string; message: Record<string, string> }): MeshMessage {
  const f = entry.message
  return {
    id: entry.id,
    ts: f.ts ?? "",
    from: f.from ?? "",
    to: f.to ?? "",
    type: (f.type ?? "note") as MeshMessage["type"],
    body: f.body != null && f.body !== "" ? (JSON.parse(f.body) as Record<string, unknown>) : {},
    correlationId: f.correlationId != null && f.correlationId !== "" ? f.correlationId : null,
    replyTo: f.replyTo != null && f.replyTo !== "" ? f.replyTo : null,
    channel,
  }
}

// Replayable read of one stream from an exclusive `since` cursor.
// `newest: true` returns the most recent `limit` entries (xRevRange) instead of
// the oldest from `since` — for inspection tooling that wants the tail of a busy
// stream. Result is always chronological (oldest-first), regardless of mode.
async function readStream(client: MeshRedis, channel: string, since: string, limit: number, newest = false): Promise<MeshMessage[]> {
  if (newest) {
    const entries = await client.xRevRange(channel, "+", "-", { COUNT: limit })
    return entries.reverse().map((e) => parseEntry(channel, e))
  }
  const start = since === "0" || since === "" ? "-" : `(${since}`
  const entries = await client.xRange(channel, start, "+", { COUNT: limit })
  return entries.map((e) => parseEntry(channel, e))
}

export async function readInbox(client: MeshRedis, args: { agentId: string; since?: string; limit?: number; newest?: boolean }): Promise<MeshMessage[]> {
  return readStream(client, inboxKey(args.agentId), args.since ?? "0", args.limit ?? 200, args.newest ?? false)
}

export async function readBroadcast(client: MeshRedis, args: { since?: string; limit?: number; newest?: boolean } = {}): Promise<MeshMessage[]> {
  return readStream(client, broadcastKey(), args.since ?? "0", args.limit ?? 200, args.newest ?? false)
}

export async function readThread(client: MeshRedis, args: { agentId: string; correlationId: string; includeBroadcast?: boolean }): Promise<MeshMessage[]> {
  const inbox = await readInbox(client, { agentId: args.agentId, since: "0", limit: 1000 })
  const broadcast = args.includeBroadcast === true ? await readBroadcast(client, { since: "0", limit: 1000 }) : []
  return [...inbox, ...broadcast].filter((m) => m.correlationId === args.correlationId).sort((a, b) => a.id.localeCompare(b.id))
}

// ---- realtime (blocking) ----

// Block until a new message lands on any of `channels` after the given per-channel
// cursors, or until blockMs elapses. Returns [] on timeout. This is the daemon's
// delivery primitive (no busy polling).
export async function waitForMessages(
  client: MeshRedis,
  args: { cursors: Record<string, string>; blockMs?: number; count?: number },
): Promise<MeshMessage[]> {
  const streams = Object.entries(args.cursors).map(([key, id]) => ({ key, id }))
  const res = await client.xRead(streams, { BLOCK: args.blockMs ?? 5000, COUNT: args.count ?? 100 })
  if (res == null) {
    return []
  }
  // node-redis types xRead's result as a broad RESP union; at runtime it's an
  // array of { name, messages: [{ id, message }] }. Narrow it explicitly.
  const streamsOut = res as unknown as Array<{ name: string; messages: Array<{ id: string; message: Record<string, string> }> }>
  const out: MeshMessage[] = []
  for (const stream of streamsOut) {
    for (const entry of stream.messages) {
      out.push(parseEntry(stream.name, entry))
    }
  }
  return out
}

// ---- admin ----

// Wipe ONLY this prefix's keys. For clean test runs; never touches app keys.
export async function resetMesh(client: MeshRedis): Promise<number> {
  const keys = await client.keys(`${agentsKey().split(":")[0]}:*`)
  if (keys.length === 0) {
    return 0
  }
  await client.del(keys)
  return keys.length
}
