// What happened while the operator was away.
//
// They open this console after a night, and the thing it does today is show them the
// bottom of a scrollback. That is the wrong shape for the one moment they are guaranteed
// to experience: they do not want to read forty messages, they want to know whether
// anything needs them and whether the things they asked for came back.
//
// Every number here is counted, never estimated, and the "needs you" list is derived
// from the message type the sender chose — an agent that publishes a `blocker` is
// saying so itself. Nothing here is a model's opinion; the assistant can be asked for
// one separately, and then it is a turn they asked for rather than a claim they have to
// audit.

import type { MeshMessage } from "./types.js"

export type DigestAsk = { correlationId: string; to: string; asked: string; askedAt: string; answeredAt: string | null }

export type Digest = {
  since: string
  /** Total messages that landed in their inbox while they were gone. */
  arrived: number
  /** Who wrote, busiest first. */
  senders: { id: string; count: number; lastAt: string; lastType: MeshMessage["type"] }[]
  /** Messages whose sender flagged them as wanting a human: blocker, decision, request. */
  needsYou: { from: string; at: string; type: MeshMessage["type"]; correlationId: string | null; text: string }[]
  /** Questions they asked that came back while they were away. */
  answered: DigestAsk[]
  /** Questions they asked that are still open, oldest first — the ones worth chasing. */
  waiting: DigestAsk[]
}

// These three are the sender's own claim that a human is needed. `status`, `result`
// and `note` are reports; promoting them would make the list everything, which is the
// same as having no list.
const WANTS_HUMAN: ReadonlySet<MeshMessage["type"]> = new Set(["blocker", "decision", "request"])

export function buildDigest(args: {
  since: string
  inbox: MeshMessage[]
  asks: DigestAsk[]
  /** Stream ids already rendered into their conversation — see `seenMeshIds`. */
  seen: ReadonlySet<string>
  bodyToText: (b: Record<string, unknown>) => string
}): Digest {
  const sinceMs = Date.parse(args.since)
  // Two filters, and they answer different questions. The window bounds VOLUME: mail
  // older than it is history, not news. The seen-set decides what they have actually
  // READ, and it is the exact answer where a clock can only approximate — a message
  // that reached a screen is in their transcript, whichever device rendered it, whatever
  // any timestamp says.
  const fresh = args.inbox.filter((m) => Date.parse(m.ts) > sinceMs && !args.seen.has(m.id))

  const bySender = new Map<string, { id: string; count: number; lastAt: string; lastType: MeshMessage["type"] }>()
  for (const m of fresh) {
    const row = bySender.get(m.from)
    if (row == null) {
      bySender.set(m.from, { id: m.from, count: 1, lastAt: m.ts, lastType: m.type })
      continue
    }
    row.count += 1
    // The inbox is in stream order, so the last one seen is the most recent.
    row.lastAt = m.ts
    row.lastType = m.type
  }

  const answeredIds = new Set(fresh.map((m) => m.correlationId).filter((c): c is string => c != null && c !== ""))
  const answered: DigestAsk[] = []
  const waiting: DigestAsk[] = []
  for (const ask of args.asks) {
    if (ask.answeredAt != null || answeredIds.has(ask.correlationId)) {
      answered.push(ask)
      continue
    }
    waiting.push(ask)
  }

  return {
    since: args.since,
    arrived: fresh.length,
    senders: [...bySender.values()].sort((a, b) => b.count - a.count),
    needsYou: fresh
      .filter((m) => WANTS_HUMAN.has(m.type))
      .map((m) => ({ from: m.from, at: m.ts, type: m.type, correlationId: m.correlationId, text: args.bodyToText(m.body).slice(0, 240) })),
    answered,
    // Oldest first: an ask that has been open longest is the one most likely to have
    // been forgotten, by the operator and by the agent.
    waiting: waiting.sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt)),
  }
}

/**
 * The mesh messages their conversation has already shown them.
 *
 * An arrival renders as one entry per sender and correlation, keyed `mesh:<stream id>`
 * and carrying every raw message it covers. So the transcript is a record of what
 * reached a screen — durable, shared across their devices, and true regardless of which
 * one rendered it. That is a far better basis for "did they see this" than any
 * timestamp, which can only say when a file was last written.
 */
export function seenMeshIds(payloads: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const payload of payloads) {
    const p = payload as { id?: unknown; metadata?: { raw?: unknown } }
    if (typeof p.id === "string" && p.id.startsWith("mesh:")) {
      ids.add(p.id.slice("mesh:".length))
    }
    // The entry id names only the FIRST message of a group; the rest are in `raw`, and
    // omitting them would re-report every message after the first in every burst.
    if (Array.isArray(p.metadata?.raw)) {
      for (const r of p.metadata.raw) {
        const id = (r as { id?: unknown }).id
        if (typeof id === "string") {
          ids.add(id)
        }
      }
    }
  }
  return ids
}

/**
 * The questions the operator asked, read back out of the stored transcript.
 *
 * The transcript is the record — every ask is already there as a completed
 * `send_message` tool call carrying its correlation id — so this survives a cleared
 * browser and works on a device that has never seen the conversation. Deriving it
 * from the client's in-memory state instead would make the digest emptiest on exactly
 * the device most likely to be showing it: the phone they just picked up.
 */
export function asksFromTranscript(payloads: unknown[]): DigestAsk[] {
  const asks = new Map<string, DigestAsk>()
  for (const payload of payloads) {
    const parts = (payload as { parts?: unknown }).parts
    if (!Array.isArray(parts)) {
      continue
    }
    for (const raw of parts) {
      const part = raw as { type?: unknown; state?: unknown; input?: { to?: unknown; text?: unknown }; output?: { sent?: unknown; correlationId?: unknown; at?: unknown } }
      if (part.type !== "tool-send_message" || part.state !== "output-available" || part.output?.sent !== true) {
        continue
      }
      const correlationId = typeof part.output?.correlationId === "string" ? part.output.correlationId : ""
      const to = typeof part.input?.to === "string" ? part.input.to : ""
      if (correlationId === "" || to === "") {
        continue // an uncorrelated send can never be resolved, so it is not an ask
      }
      asks.set(correlationId, {
        correlationId,
        to,
        asked: typeof part.input?.text === "string" ? part.input.text.slice(0, 200) : "",
        askedAt: typeof part.output?.at === "string" ? part.output.at : new Date(0).toISOString(),
        answeredAt: null,
      })
    }
  }
  return [...asks.values()]
}
