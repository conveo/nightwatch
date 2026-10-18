// The console's side of the durable transcript: reading, saving, and folding the
// server copy into a surface's own.

import type { UIMessage } from "ai"
import { mergeTranscripts } from "../../../src/transcript-merge.ts"

export function transcriptUrl(conversationId: string): string {
  return `/api/console/transcript?conversation=${encodeURIComponent(conversationId)}`
}

/** A durable save, or null when it did not persist. `behind` is how many stored messages the save lacked. */
export async function saveStored(args: { conversationId: string; messages: UIMessage[] }): Promise<{ behind: number } | null> {
  try {
    const r = await fetch(transcriptUrl(args.conversationId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: args.messages }),
    })
    if (!r.ok) {
      return null
    }
    const outcome = (await r.json()) as { saved: boolean; behind: number }
    return outcome.saved ? outcome : null
  } catch {
    return null
  }
}

/** This surface's messages folded into the server's, by the same merge the server saves with. */
export function withStored(args: { stored: UIMessage[]; local: UIMessage[] }): UIMessage[] {
  const row = (m: UIMessage) => ({ id: m.id, payload: m })
  return mergeTranscripts({ stored: args.stored.map(row), incoming: args.local.map(row) }).rows.map((r) => r.payload)
}
