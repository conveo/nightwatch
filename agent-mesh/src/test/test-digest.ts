// The digest's derivation: what counts as "missed", and what the operator has already read.
//
// The interesting case is the one a clock cannot get right. The transcript is saved
// by any surface that merely opens the console, so every stored timestamp drifts
// forward without them reading anything — which is why "seen" is decided by what is in
// their conversation, not by when a file was written.

import assert from "node:assert/strict"
import { asksFromTranscript, buildDigest, seenMeshIds } from "../digest.js"
import type { MeshMessage } from "../types.js"

const msg = (id: string, over: Partial<MeshMessage> = {}): MeshMessage => ({
  id,
  ts: "2026-09-18T22:00:00Z",
  from: "worker",
  to: "operator",
  channel: "mesh:inbox:operator",
  type: "status",
  body: { text: "something happened" },
  correlationId: null,
  replyTo: null,
  ...over,
})

const bodyToText = (b: Record<string, unknown>) => String(b.text ?? "")

export function runDigestTest(): number {
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

  console.log("\n[digest] derivation")

  check("a message already rendered into their conversation is not something they missed", () => {
    const seen = seenMeshIds([{ id: "mesh:100-0", metadata: {} }])
    const d = buildDigest({ since: "2026-09-18T00:00:00Z", inbox: [msg("100-0"), msg("101-0")], asks: [], seen, bodyToText })
    assert.equal(d.arrived, 1)
    assert.equal(d.senders[0].count, 1)
  })

  check("every message of a grouped burst counts as seen, not only the one in the entry id", () => {
    // An entry is keyed on the FIRST message of its group and carries the rest in
    // `raw`. Reading only the id would re-report everything after the first, every
    // morning, for every burst.
    const seen = seenMeshIds([{ id: "mesh:100-0", metadata: { raw: [{ id: "100-0" }, { id: "100-1" }, { id: "100-2" }] } }])
    const d = buildDigest({ since: "2026-09-18T00:00:00Z", inbox: [msg("100-0"), msg("100-1"), msg("100-2")], asks: [], seen, bodyToText })
    assert.equal(d.arrived, 0)
  })

  check("the window still bounds volume — old unseen mail is history, not news", () => {
    const d = buildDigest({
      since: "2026-09-18T22:00:00Z",
      inbox: [msg("1-0", { ts: "2026-09-01T00:00:00Z" }), msg("2-0", { ts: "2026-09-18T23:00:00Z" })],
      asks: [],
      seen: new Set(),
      bodyToText,
    })
    assert.equal(d.arrived, 1)
  })

  check("needs-you is the sender's own claim, not a reading of the prose", () => {
    const d = buildDigest({
      since: "2026-09-18T00:00:00Z",
      inbox: [msg("1-0", { type: "blocker" }), msg("2-0", { type: "status", body: { text: "urgent! decide now!" } }), msg("3-0", { type: "request" })],
      asks: [],
      seen: new Set(),
      bodyToText,
    })
    assert.deepEqual(
      d.needsYou.map((n) => n.type),
      ["blocker", "request"],
    )
  })

  check("an ask answered before they left is not still waiting", () => {
    const asks = [
      { correlationId: "a", to: "worker", asked: "do a", askedAt: "2026-09-18T10:00:00Z", answeredAt: "2026-09-18T10:05:00Z" },
      { correlationId: "b", to: "worker", asked: "do b", askedAt: "2026-09-18T09:00:00Z", answeredAt: null },
    ]
    const d = buildDigest({ since: "2026-09-18T22:00:00Z", inbox: [], asks, seen: new Set(), bodyToText })
    assert.deepEqual(d.answered.map((a) => a.correlationId), ["a"])
    assert.deepEqual(d.waiting.map((a) => a.correlationId), ["b"])
  })

  check("an uncorrelated send is not an ask — it can never be resolved", () => {
    const asks = asksFromTranscript([
      { parts: [{ type: "tool-send_message", state: "output-available", input: { to: "worker", text: "fyi" }, output: { sent: true, correlationId: "", at: "2026-09-18T10:00:00Z" } }] },
      { parts: [{ type: "tool-send_message", state: "output-available", input: { to: "worker", text: "please do x" }, output: { sent: true, correlationId: "c1", at: "2026-09-18T10:00:00Z" } }] },
    ])
    assert.deepEqual(asks.map((a) => a.correlationId), ["c1"])
  })

  return failures
}
