// The transcript store end to end, against the scratch database run.ts points
// CONSOLE_DATABASE_URL at. The merge itself is covered in test-transcript-merge.ts;
// this covers what only the store can get wrong — two saves racing each other.

import assert from "node:assert/strict"
import { loadTranscript, saveTranscript, type StoredMessage } from "../console-db.js"

const row = (id: string): StoredMessage => ({ id, role: "user", payload: { id, role: "user", parts: [{ type: "text", text: id }] }, author: null, correlationId: null })
const messageIds = (rows: StoredMessage[]) => rows.map((r) => (r.payload as { id: string }).id)

export async function runTranscriptStoreTest(): Promise<number> {
  let failures = 0
  const check = async (name: string, test: () => Promise<void>) => {
    try {
      await test()
      console.log(`  [PASS] ${name}`)
    } catch (error) {
      failures++
      console.error(`  [FAIL] ${name}`, error)
    }
  }
  console.log("\n[console] transcript store")

  // FIRST, while the database file is still empty: this is the page load that fires
  // several requests before anything has migrated.
  await check("concurrent first requests all find the store ready", async () => {
    const outcomes = await Promise.all(["first-1", "first-2", "first-3", "first-4"].map((conversationId) => saveTranscript({ conversationId, messages: [row("a")] })))
    assert.deepEqual(
      outcomes.map((o) => o.reason ?? "saved"),
      ["saved", "saved", "saved", "saved"],
    )
  })

  await check("two devices saving at the same moment both keep their message", async () => {
    // Serialisation is what this proves. The merge reads before it writes, so two
    // saves merging from the same snapshot would each write a copy missing the other.
    const conversationId = "race"
    const base = ["a", "b", "c"].map(row)
    await saveTranscript({ conversationId, messages: base })
    const [desktop, phone] = await Promise.all([
      saveTranscript({ conversationId, messages: [...base, row("d")] }),
      saveTranscript({ conversationId, messages: [...base, row("p")] }),
    ])
    assert.equal(desktop.saved && phone.saved, true)
    assert.deepEqual(messageIds(await loadTranscript(conversationId)), ["a", "b", "c", "d", "p"])
  })

  await check("a save reports how many stored messages the surface is missing", async () => {
    const conversationId = "behind"
    await saveTranscript({ conversationId, messages: ["a", "b", "c"].map(row) })
    const stale = await saveTranscript({ conversationId, messages: [row("a"), row("x")] })
    assert.equal(stale.behind, 2)
    assert.deepEqual(messageIds(await loadTranscript(conversationId)), ["a", "b", "c", "x"])
  })

  await check("history past the served window survives, and resending it changes nothing", async () => {
    // A cap on what is SERVED. A stale surface resending messages older than the window
    // must not bring them back as new turns, nor push the newest out.
    const conversationId = "long"
    const all = Array.from({ length: 450 }, (_, i) => row(`m${i}`))
    await saveTranscript({ conversationId, messages: all })
    const stale = await saveTranscript({ conversationId, messages: all.slice(0, 60) })
    assert.equal(stale.stored, 450, "nothing trimmed, nothing duplicated")
    const served = messageIds(await loadTranscript(conversationId))
    assert.deepEqual([served.length, served[0], served.at(-1)], [400, "m50", "m449"])
  })

  await check("a message updated in place is stored at its new version", async () => {
    // The incremental write: an unchanged prefix, one row rewritten.
    const conversationId = "streamed"
    const text = (id: string, t: string): StoredMessage => ({ ...row(id), payload: { id, role: "assistant", parts: [{ type: "text", text: t }] } })
    await saveTranscript({ conversationId, messages: [row("a"), text("r", "partial")] })
    await saveTranscript({ conversationId, messages: [row("a"), text("r", "partial and finished")] })
    const stored = await loadTranscript(conversationId)
    assert.deepEqual(stored.map((m) => (m.payload as { parts: { text: string }[] }).parts[0].text), ["a", "partial and finished"])
  })

  await check("a surface bringing back older history puts it first", async () => {
    // The rewrite path: positions move, so the conversation is rewritten in order.
    const conversationId = "older"
    await saveTranscript({ conversationId, messages: [row("c"), row("d")] })
    await saveTranscript({ conversationId, messages: [row("a"), row("b"), row("c")] })
    assert.deepEqual(messageIds(await loadTranscript(conversationId)), ["a", "b", "c", "d"])
  })

  return failures
}
