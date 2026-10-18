// Saving a transcript merges by message id. Each case is a real save sequence, and the
// first is the one a replace got wrong: two devices appending at once.

import assert from "node:assert/strict"
import { mergeTranscripts } from "../transcript-merge.js"

type R = { id: string; payload: unknown }
const row = (id: string, text = id): R => ({ id, payload: { id, parts: [{ type: "text", text }] } })
const ids = (rows: R[]) => rows.map((r) => r.id)
const texts = (rows: R[]) => rows.map((r) => ((r.payload as { parts: { text: string }[] }).parts[0].text))

export function runTranscriptMergeTest(): number {
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

  console.log("\n[console] transcript merge")

  const base = ["a", "b", "c"].map((i) => row(i))

  check("two devices appending at once both keep their message", () => {
    // Both loaded a,b,c; desktop added d, phone added p. Both send four messages, so a
    // length floor passes both, and a replace keeps only the last.
    const afterDesktop = mergeTranscripts({ stored: base, incoming: [...base, row("d")] }).rows
    const afterPhone = mergeTranscripts({ stored: afterDesktop, incoming: [...base, row("p")] }).rows
    assert.deepEqual(ids(afterPhone), ["a", "b", "c", "d", "p"])
  })

  check("a stale surface holding fewer messages deletes nothing", () => {
    // The case a length floor exists for — impossible here rather than refused.
    const r = mergeTranscripts({ stored: [...base, row("d"), row("e")], incoming: [row("a"), row("b"), row("x")] })
    assert.deepEqual(ids(r.rows), ["a", "b", "c", "d", "e", "x"])
  })

  check("a message streamed in place keeps its latest version", () => {
    const r = mergeTranscripts({ stored: [...base, row("m", "partial")], incoming: [...base, row("m", "partial and finished")] })
    assert.deepEqual(texts(r.rows), ["a", "b", "c", "partial and finished"])
  })

  check("a one-message save appends to an existing conversation", () => {
    // How a reply for a conversation that is not on screen is stored.
    const r = mergeTranscripts({ stored: base, incoming: [row("mesh:1789-0")] })
    assert.deepEqual(ids(r.rows), ["a", "b", "c", "mesh:1789-0"])
  })

  check("behind counts the stored messages the client did not have", () => {
    assert.equal(mergeTranscripts({ stored: [...base, row("d")], incoming: [row("a"), row("b")] }).behind, 2)
    assert.equal(mergeTranscripts({ stored: base, incoming: [...base, row("d")] }).behind, 0)
  })

  check("history older than the served window goes in front, not at the end", () => {
    // The server sends the newest messages only; a surface can hold older ones.
    const r = mergeTranscripts({ stored: [row("c"), row("d"), row("e")], incoming: [row("a"), row("b"), row("c"), row("f")] })
    assert.deepEqual(ids(r.rows), ["a", "b", "c", "d", "e", "f"])
  })

  check("missing history older than the surface's window is not behind", () => {
    const r = mergeTranscripts({ stored: ["a", "b", "c", "d", "e"].map((i) => row(i)), incoming: [row("d"), row("e")] })
    assert.equal(r.behind, 0)
  })

  check("a message with no id does not duplicate on every save", () => {
    const unkeyed = row("", "no id")
    const once = mergeTranscripts({ stored: base, incoming: [...base, unkeyed] }).rows
    const twice = mergeTranscripts({ stored: once, incoming: [...base, unkeyed] }).rows
    assert.equal(twice.length, 4)
  })

  return failures
}
