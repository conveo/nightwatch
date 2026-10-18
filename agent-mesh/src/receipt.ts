// Deriving what happened to a message the operator sent, from what the mesh can prove.
//
// Separated from the route because the derivation is where this has gone wrong twice.
// Both times the shape of the bug was identical: two fields computed from different
// evidence, reported side by side, contradicting each other — delivered:false beside
// answered:true, then read:false beside answered:true. A confident false is worse than
// an admitted unknown here, because the badge exists to stop them misreading a quiet
// agent as a broken product, and one visible lie retires the whole feature.

import type { MeshMessage } from "./types.js"

export type Receipt = {
  delivered: boolean | null
  deliveredReason: "found-in-inbox" | "inbox-unreadable" | "no-request-from-you"
  requestAt: string | null
  read: boolean | null
  readReason: "answered-it" | "read-cursor" | "cursor-not-visible"
  readKnown: boolean
  answered: boolean
  answeredAt: string | null
}

export type ReceiptEvidence = {
  /** The recipient's inbox, or null when it could not be read at all. */
  // `historyOffset` is where `history[0]` sits in the agent's WHOLE inbox. `history` is
  // a window (the tail), while `readCount` counts from the inbox's start — so positions
  // must be compared in the same frame or a large inbox reads as fully read.
  theirs: { history: MeshMessage[]; source: string; readCount: number | null; historyOffset: number } | null
  /** The message from the operator on this correlation, found in the recipient's inbox. */
  request: MeshMessage | null
  /** The recipient's reply on this correlation, found in the operator's inbox. */
  answer: MeshMessage | null
}

export function deriveReceipt(e: ReceiptEvidence): Receipt {
  let read: boolean | null = null
  let readReason: Receipt["readReason"] = "cursor-not-visible"
  // A reply to the request PROVES it was read, and it outranks the cursor. `readCount`
  // is the legacy inbox cursor; a managed agent receives through a different one and
  // never advances it, so the cursor alone reports "not read yet" beside an answer
  // already on screen.
  if (e.request != null && e.answer != null && Date.parse(e.answer.ts) >= Date.parse(e.request.ts)) {
    read = true
    readReason = "answered-it"
  } else if (e.theirs?.source === "local-buffer" && e.theirs.readCount != null && e.request != null) {
    const index = e.theirs.history.findIndex((m) => m.id === e.request?.id)
    read = index >= 0 ? e.theirs.historyOffset + index < e.theirs.readCount : null
    readReason = read != null ? "read-cursor" : "cursor-not-visible"
  }

  // `delivered` is nullable because "no message from you on this correlation" is not
  // "your message was not delivered" — it is far more often a thread somebody else
  // started, which the operator is merely reading. Saying "not delivered" next to a visible
  // answer is the exact contradiction that made this file worth its own module.
  const deliveredReason: Receipt["deliveredReason"] = e.theirs == null ? "inbox-unreadable" : e.request != null ? "found-in-inbox" : "no-request-from-you"

  return {
    delivered: e.request != null ? true : null,
    deliveredReason,
    requestAt: e.request?.ts ?? null,
    read,
    readReason,
    readKnown: readReason !== "cursor-not-visible",
    answered: e.answer != null,
    answeredAt: e.answer?.ts ?? null,
  }
}
