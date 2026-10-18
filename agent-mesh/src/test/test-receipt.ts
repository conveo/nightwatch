// The receipt derivation, which has produced a self-contradicting answer twice.
//
// Every case here is a pair of fields that must not disagree. The bugs were not
// "wrong value" bugs — each field was individually defensible — they were bugs of two
// fields answering from different evidence and being printed side by side.

import assert from "node:assert/strict"
import { deriveReceipt } from "../receipt.js"
import type { MeshMessage } from "../types.js"

const at = (ts: string, over: Partial<MeshMessage> = {}): MeshMessage => ({
  id: `${Date.parse(ts)}-0`,
  ts,
  from: "operator",
  to: "worker",
  channel: "mesh:inbox:worker",
  type: "request",
  body: { text: "do the thing" },
  correlationId: "corr-1",
  replyTo: null,
  ...over,
})

export function runReceiptTest(): number {
  let failures = 0
  const check = (name: string, test: () => void) => {
    try {
      test()
      console.log(`  [PASS] ${name}`)
    } catch (error) {
      failures++
      console.error(`  [FAIL] ${name}`, error)
    }
  }

  console.log("\n[receipt] derivation")

  check("an answer on a correlation the operator never sent on is not an undelivered message", () => {
    const answer = at("2026-09-18T20:08:59Z", { from: "worker", to: "operator" })
    const r = deriveReceipt({ theirs: { history: [], source: "local-buffer", readCount: 0, historyOffset: 0 }, request: null, answer })
    assert.equal(r.answered, true)
    // The regression: this returned delivered=false beside answered=true.
    assert.equal(r.delivered, null)
    assert.equal(r.deliveredReason, "no-request-from-you")
  })

  check("a reply proves the request was read, even when the legacy cursor has not moved", () => {
    const request = at("2026-09-18T21:38:34Z")
    const answer = at("2026-09-18T21:40:07Z", { from: "worker", to: "operator" })
    // readCount 0 means the legacy cursor never advanced — which is normal for an
    // agent that receives through the managed cursor instead.
    const r = deriveReceipt({ theirs: { history: [request], source: "local-buffer", readCount: 0, historyOffset: 0 }, request, answer })
    assert.equal(r.answered, true)
    // The second regression: this returned read=false beside answered=true.
    assert.equal(r.read, true)
    assert.equal(r.readReason, "answered-it")
    assert.equal(r.readKnown, true)
  })

  check("an unanswered request past the cursor is honestly 'not read yet'", () => {
    const request = at("2026-09-18T21:38:34Z")
    const r = deriveReceipt({ theirs: { history: [at("2026-09-18T21:00:00Z", { id: "older" }), request], source: "local-buffer", readCount: 1, historyOffset: 0 }, request, answer: null })
    assert.equal(r.delivered, true)
    assert.equal(r.read, false)
    assert.equal(r.readReason, "read-cursor")
    assert.equal(r.answered, false)
  })

  check("a remote-served agent reports read as unknown, never as false", () => {
    const request = at("2026-09-18T21:38:34Z")
    const r = deriveReceipt({ theirs: { history: [request], source: "broker", readCount: null, historyOffset: 0 }, request, answer: null })
    assert.equal(r.delivered, true)
    assert.equal(r.read, null)
    assert.equal(r.readKnown, false)
    assert.equal(r.readReason, "cursor-not-visible")
  })

  check("an unreadable inbox is unknown delivery, not failed delivery", () => {
    const r = deriveReceipt({ theirs: null, request: null, answer: null })
    assert.equal(r.delivered, null)
    assert.equal(r.deliveredReason, "inbox-unreadable")
    assert.equal(r.read, null)
  })

  check("an answer that predates the request does not count as having read it", () => {
    // Same correlation reused across two exchanges: the older reply answers the
    // EARLIER request, so it proves nothing about this one.
    const request = at("2026-09-18T21:38:34Z")
    const answer = at("2026-09-18T20:00:00Z", { from: "worker", to: "operator" })
    const r = deriveReceipt({ theirs: { history: [request], source: "local-buffer", readCount: 0, historyOffset: 0 }, request, answer })
    assert.notEqual(r.readReason, "answered-it")
    assert.equal(r.read, false)
  })

  check("a read position is compared in the same frame as the request's position", () => {
    // The regression: the history is the LAST 200 lines of a 1,000-line inbox, but
    // readCount counts from the start of the whole inbox. Comparing a position in the
    // window (180) with the absolute read count (950) reported every windowed message
    // as read — including the 50 unread ones at the tail, like this request at 980.
    const request = at("2026-09-23T07:00:00Z")
    const window = Array.from({ length: 200 }, (_, i) => (i === 180 ? request : at("2026-09-23T06:00:00Z", { id: `w-${i}` })))
    const r = deriveReceipt({ theirs: { history: window, source: "local-buffer", readCount: 950, historyOffset: 800 }, request, answer: null })
    assert.equal(r.read, false, "absolute position 980 is past a read count of 950")
    assert.equal(r.readReason, "read-cursor")
  })

  check("a request the agent has read inside a windowed history reads as read", () => {
    const request = at("2026-09-23T07:00:00Z")
    const window = Array.from({ length: 200 }, (_, i) => (i === 10 ? request : at("2026-09-23T06:00:00Z", { id: `w-${i}` })))
    const r = deriveReceipt({ theirs: { history: window, source: "local-buffer", readCount: 950, historyOffset: 800 }, request, answer: null })
    assert.equal(r.read, true, "absolute position 810 is before a read count of 950")
  })

  return failures
}
