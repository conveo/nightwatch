// Wire types + runtime schemas for the agent hub.
//
// A message is addressed to ONE agent id, a host fan-out ("host:<hostname>"), or
// the literal "broadcast"; it carries a typed payload and can thread onto an
// earlier message via correlationId/replyTo.
// Validated with zod at every trust boundary (CLI input, daemon API) so a
// malformed message never silently corrupts an inbox.

import { z } from "zod"

export const MESSAGE_TYPES = ["status", "blocker", "decision", "request", "result", "note"] as const
export type MessageType = (typeof MESSAGE_TYPES)[number]

// online  : a live owning process backs this registration (or, at read time, a
//           recent host heartbeat and no dead-mark).
// dead     : the daemon's liveness sweep found the owning process GONE while the
//           host is still heartbeating. Distinct from `stale`.
// stale    : no host heartbeat within staleAfterMs — the whole daemon/host is
//            gone, so we can't say anything about individual processes.
// offline  : explicitly set; sticky.
export const AGENT_STATUSES = ["online", "dead", "stale", "offline"] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

export const BROADCAST = "broadcast" as const

// Prefix for a host-scoped fan-out target: `host:<hostname>` reaches every agent
// on that one host (vs. `broadcast`, which is mesh-wide and almost never what you
// want). agentIdSchema forbids `:`, so the host form is validated separately and
// the two never collide.
const HOST_TARGET_PREFIX = "host:" as const

// Agent ids flow into Redis key names (`mesh:inbox:<id>`) and host-local file
// paths (`inbox/<id>.jsonl`). Restrict them to a safe charset at the trust
// boundary so an id can never contain `/`, `..`, `:` or whitespace — which would
// otherwise enable path traversal or key injection. (Even with no auth on the
// dev socket, this keeps a buggy/hostile caller from escaping the namespace.)
export const agentIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, "agent id must match [A-Za-z0-9._-] (no slashes, dots-dots, colons or spaces)")

// A publish recipient is one of: a specific agent id, the literal "broadcast"
// (both match agentIdSchema), or "host:<hostname>" (host-scoped fan-out). The
// hostname segment uses the same safe charset as an id, so it's safe in a key.
const hostTargetSchema = z
  .string()
  .regex(new RegExp(`^${HOST_TARGET_PREFIX}[A-Za-z0-9._-]+$`), "host target must be 'host:<hostname>' ([A-Za-z0-9._-], no slashes/spaces)")
const recipientSchema = z.union([agentIdSchema, hostTargetSchema])

// If `to` is a "host:<hostname>" target, return the hostname; otherwise null.
export function hostTarget(to: string): string | null {
  return to.startsWith(HOST_TARGET_PREFIX) ? to.slice(HOST_TARGET_PREFIX.length) : null
}

// ---- messages ----

// What a caller provides when publishing (no id/ts yet — the hub assigns those).
export const publishInputSchema = z.object({
  from: agentIdSchema,
  to: recipientSchema.describe("recipient agent id, 'broadcast', or 'host:<hostname>'"),
  type: z.enum(MESSAGE_TYPES),
  body: z.record(z.string(), z.unknown()).default({}),
  correlationId: z.string().nullable().default(null),
  replyTo: z.string().nullable().default(null),
})
export type PublishInput = z.input<typeof publishInputSchema>

// A stored/delivered message, as it comes back off a stream — or as the console's
// browser posts it back to be narrated, which is a trust boundary: those elements go
// straight into a model's context. The type is derived from the schema so the two
// cannot drift.
export const meshMessageSchema = z.object({
  id: z.string(), // redis stream id "<ms>-<seq>" — total order + replay cursor
  ts: z.string(), // ISO timestamp set at publish
  from: z.string(),
  to: z.string(),
  type: z.enum(MESSAGE_TYPES),
  body: z.record(z.string(), z.unknown()),
  correlationId: z.string().nullable(),
  replyTo: z.string().nullable(),
  channel: z.string(), // which stream it was read from (inbox, host-broadcast, or broadcast key)
})
export type MeshMessage = z.infer<typeof meshMessageSchema>

// Ack for `agent-mesh watch`: advance the watch cursor to an absolute inbox
// position previously returned by the watch peek (see local-store.peekWatch).
export const watchAckInputSchema = z.object({
  id: agentIdSchema,
  upTo: z.number().int().nonnegative(),
  generation: z.string().uuid().optional(),
})

// ---- agents ----

export const registerInputSchema = z.object({
  id: agentIdSchema,
  role: z.string().min(1),
  host: z.string().nullable().default(null),
  meta: z.record(z.string(), z.unknown()).default({}),
})
export type RegisterInput = z.input<typeof registerInputSchema>

export type AgentRecord = {
  id: string
  role: string
  host: string | null
  meta: Record<string, unknown>
  status: AgentStatus
  registeredAt: string
  lastSeen: string
}

// Redis stores stream fields as strings; this is the on-wire field shape we
// XADD and parse back. Kept explicit so encode/decode stay in lockstep.
export type StreamFields = {
  ts: string
  from: string
  to: string
  type: string
  body: string // JSON
  correlationId: string
  replyTo: string
}
