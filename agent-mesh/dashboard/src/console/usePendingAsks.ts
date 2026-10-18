// What the operator is currently waiting on.
//
// Derived from the conversation rather than stored alongside it: every ask is already
// recorded in the transcript as a completed `send_message` tool call carrying its
// correlationId, so a second source of truth could only drift. When an inbound reply
// carries one of these correlation ids, the narration turn is told what the original
// question was and how long ago — which is what turns "check again" from a habit into
// something they never have to think about.

import type { UIMessage } from "ai"
import { useMemo } from "react"

export type PendingAsk = {
  correlationId: string
  to: string
  asked: string
  askedAt: string
  askedAtMs: number
}

// Past this an unanswered ask stops being "pending" and becomes history. Agents that
// are going to answer answer within minutes; keeping a two-hour-old question on the
// waiting list would make every later arrival look like a resolution.
const STALE_MS = 30 * 60 * 1000

export function usePendingAsks(messages: UIMessage[]): PendingAsk[] {
  return useMemo(() => {
    const asks = new Map<string, PendingAsk>()
    for (const m of messages) {
      for (const part of m.parts) {
        if (part.type !== "tool-send_message") {
          continue
        }
        const p = part as {
          state?: string
          input?: { to?: unknown; text?: unknown; correlationId?: unknown }
          output?: { sent?: unknown; correlationId?: unknown; at?: unknown }
        }
        if (p.state !== "output-available" || p.output?.sent !== true) {
          continue
        }
        // Prefer the id the SERVER used: it mints one when the model left the field
        // empty, so the output is the only place the real value is guaranteed.
        const corr =
          typeof p.output?.correlationId === "string" && p.output.correlationId.trim() !== ""
            ? p.output.correlationId.trim()
            : typeof p.input?.correlationId === "string"
              ? p.input.correlationId.trim()
              : ""
        const to = typeof p.input?.to === "string" ? p.input.to : ""
        const text = typeof p.input?.text === "string" ? p.input.text : ""
        // Only a correlated ask can be resolved by an incoming reply; an uncorrelated
        // send is fire-and-forget and claiming otherwise would be a lie in the UI.
        if (corr === "" || to === "") {
          continue
        }
        // The mesh's own send time, not now(). A UIMessage has no timestamp, so before
        // the tool started returning `at` this read Date.now() at RENDER — which made
        // every ask permanently zero minutes old, so nothing ever aged out of the
        // pending list and "asked 4 minutes ago" was never true. Transcripts written
        // before that fall back to now and simply age from when they were first seen.
        const sentAt = typeof p.output?.at === "string" ? Date.parse(p.output.at) : Number.NaN
        const at = Number.isFinite(sentAt) ? sentAt : Date.now()
        asks.set(corr, {
          correlationId: corr,
          to,
          asked: text.slice(0, 300),
          askedAt: new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
          askedAtMs: at,
        })
      }
    }
    const now = Date.now()
    return [...asks.values()].filter((a) => now - a.askedAtMs < STALE_MS)
  }, [messages])
}

/** Correlation ids among `arriving` that resolve something the operator asked. */
export function resolvedBy(arriving: Array<{ correlationId: string | null }>, pending: PendingAsk[]): PendingAsk[] {
  const ids = new Set(arriving.map((m) => m.correlationId).filter((c): c is string => c != null && c !== ""))
  return pending.filter((p) => ids.has(p.correlationId))
}
