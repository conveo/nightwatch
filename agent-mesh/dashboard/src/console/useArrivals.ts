// Arrivals: one queue for the whole app session, owned by the shell.
//
// Not by the chat view. A view is one conversation and unmounts on every switch (and
// on the phone, whenever a thread is open), so a view that handles arrivals misfiles
// one whenever the operator moves mid-recap: the unmounting view finishes it into the chat they
// just left, without its recap, while the view they open skips it as already handled.
// The shell outlives every view, knows which chat is open NOW, and treats a view as
// nothing more than a place to show an entry while it is on screen.

import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai"
import { type MutableRefObject, useEffect, useRef } from "react"
import type { MeshMessage } from "@/lib/api"
import { bodyToText } from "./console-api"
import { saveStored } from "./transcript-client"
import { type InboxArrival, reportClientEvent } from "./useInboxStream"
import type { PendingAsk } from "./usePendingAsks"

/** The chat view on screen, offering to show arrivals that belong to its conversation. */
export type ArrivalSink = {
  conversationId: string
  /** Put the entry in the thread, replacing an earlier version of it by id. */
  show: (entry: UIMessage) => void
  recent: () => UIMessage[]
  pending: () => PendingAsk[]
}

/**
 * Present every arrival, in order, and store each in the conversation that owns it.
 *
 * Returns the ref a chat view registers itself in. Groups run strictly one after
 * another on one chain that is never cancelled: two recaps streaming at once would
 * interleave, and a later arrival must not abandon the rest of an earlier batch whose
 * ids the inbox has already recorded as delivered.
 */
export function useArrivals(args: { arrival: InboxArrival | null; activeConversation: string; onSaved: () => void }): MutableRefObject<ArrivalSink | null> {
  const sinkRef = useRef<ArrivalSink | null>(null)
  // Read at each step, not captured: which chat is open, and how to tell the switcher
  // one was written to, are both whatever they are at the moment they are needed.
  const activeRef = useRef(args.activeConversation)
  activeRef.current = args.activeConversation
  const onSavedRef = useRef(args.onSaved)
  onSavedRef.current = args.onSaved
  const handled = useRef(new Set<number>())
  const queue = useRef<Promise<void>>(Promise.resolve())

  const { arrival } = args
  useEffect(() => {
    if (arrival == null || handled.current.has(arrival.at)) {
      return
    }
    handled.current.add(arrival.at)
    for (const group of groupArrivals(arrival.messages)) {
      queue.current = queue.current.then(() => present({ group, sinkRef, active: () => activeRef.current, onSaved: () => onSavedRef.current() }))
    }
  }, [arrival])

  return sinkRef
}

/**
 * One group, one timeline entry — shown if its chat is on screen, stored either way.
 *
 * The entry is created carrying the raw messages, so nothing is lost if the recap never
 * arrives, and the recap then replaces its text as the readable layer. Two stacked
 * items (a turn plus a comment on it) would double the length of the timeline.
 */
async function present(args: { group: MeshMessage[]; sinkRef: MutableRefObject<ArrivalSink | null>; active: () => string; onSaved: () => void }): Promise<void> {
  const { group } = args
  const entry = toMeshEntry(`mesh:${group[0].id}`, group)
  // No known owner: news, filed where the operator is looking when it arrives.
  const owner = (await arrivalOwner(group)) ?? args.active()
  // Re-read at every step, since they can switch chats mid-recap: the entry keeps
  // streaming into the owner's view if it is on screen, and stops showing if not.
  const view = (): ArrivalSink | null => {
    const sink = args.sinkRef.current
    return sink?.conversationId === owner ? sink : null
  }
  const store = async (message: UIMessage) => {
    // Stored in the conversation that owns it, whether or not it is on screen: by now
    // the inbox has advanced past it and this browser has marked it seen, so for a
    // chat that is not open this write is the ONLY place it lands. The server merges
    // by id, so a one-entry save is an append — or, for the recap, an update in place.
    if ((await saveStored({ conversationId: owner, messages: [message] })) != null) {
      args.onSaved()
    }
  }

  view()?.show(entry)
  // Before the recap starts, so the raw can never land after — and overwrite — it.
  await store(entry)

  const context = view()
  let final = entry
  await narrate({
    arriving: group,
    recent: context?.recent() ?? [],
    pending: context?.pending() ?? [],
    onSnapshot: (m) => {
      // Text only, and WITHOUT providerMetadata. Those ids are OpenAI's claim about its
      // own conversation state; stored in the transcript they get replayed into a later
      // request whose lineage never had them, and the provider rejects the whole call.
      // A recap is a rendering artifact, not a resumable model item.
      const recap = m.parts.filter((part) => part.type === "text").map((part) => ({ type: "text" as const, text: part.text }))
      if (recap.length === 0) {
        return
      }
      final = { ...entry, parts: recap }
      view()?.show(final)
    },
  })
  // Recapped off screen, too: an arrival for a chat the operator is not in still reads as a
  // sentence when they open it, not as a raw envelope.
  if (final !== entry) {
    await store(final)
  }
}

/**
 * Run one narration turn for a batch of arrivals and stream it into the conversation.
 *
 * `readUIMessageStream` yields the same message object repeatedly as it fills in, so
 * the caller replaces by id rather than appending — appending would stack one copy
 * per token.
 */
async function narrate(args: {
  arriving: MeshMessage[]
  recent: UIMessage[]
  pending: PendingAsk[]
  onSnapshot: (message: UIMessage) => void
}): Promise<void> {
  try {
    const res = await fetch("/api/console/narrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: args.arriving,
        // Enough for the assistant to know what the operator was doing; not so much that an
        // unprompted turn costs as much as a real one.
        recent: args.recent.slice(-6),
        pending: args.pending,
      }),
    })
    if (!res.ok || res.body == null) {
      // Previously a bare return. A narration that fails must not inject an error
      // bubble into a conversation the operator did not start — but it must not vanish without
      // trace either, which is how one lost message cost a round of guessing.
      reportClientEvent("narrate-failed", args.arriving.map((m) => m.id), `http ${res.status}`)
      return
    }
    const stream = readUIMessageStream({
      stream: res.body.pipeThrough(new TextDecoderStream()).pipeThrough(new JsonEventStream()),
    })
    for await (const message of stream) {
      args.onSnapshot(message)
    }
    reportClientEvent("narrate-ok", args.arriving.map((m) => m.id))
  } catch (e) {
    // Still silent in the UI — an error bubble in a conversation the operator did not start is
    // worse than none — but never silent in the log.
    reportClientEvent("narrate-threw", args.arriving.map((m) => m.id), (e as Error).message)
  }
}

/** Parse the `data:` payloads of an SSE body into the chunk objects the SDK expects. */
class JsonEventStream extends TransformStream<string, UIMessageChunk> {
  constructor() {
    let buffer = ""
    super({
      transform(chunk, controller) {
        buffer += chunk
        const frames = buffer.split("\n\n")
        buffer = frames.pop() ?? ""
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) {
              continue
            }
            const payload = line.slice(6)
            if (payload === "[DONE]") {
              continue
            }
            try {
              controller.enqueue(JSON.parse(payload) as UIMessageChunk)
            } catch {
              // a partial frame across a chunk boundary — the buffer picks it up
            }
          }
        }
      },
    })
  }
}

/**
 * Which conversation an arrival belongs to, or null when it has no known owner.
 *
 * A reply belongs where the question was asked. Narrating a correlated answer into
 * whatever chat happens to be open is wrong exactly when it matters — the answer
 * arrives without its question. Uncorrelated mail, and a correlation this console
 * never asked, have no owner: they are news, shown where the operator is looking.
 */
async function arrivalOwner(arriving: MeshMessage[]): Promise<string | null> {
  const correlated = arriving.find((m) => m.correlationId != null && m.correlationId !== "")
  if (correlated?.correlationId == null) {
    return null
  }
  try {
    const res = await fetch(`/api/console/arrival-owner?correlationId=${encodeURIComponent(correlated.correlationId)}`)
    if (!res.ok) {
      return null
    }
    const { conversationId } = (await res.json()) as { conversationId: string | null }
    return conversationId
  } catch {
    return null
  }
}

/**
 * Split one arrival window into the things it actually contains.
 *
 * The batching window is 1.2 seconds, which is a statement about typing latency, not
 * about meaning. Three messages from one agent answering one request ARE one thing and
 * collapse cleanly. Two agents answering two different questions inside the same
 * second are two things, and folding them under a single recap would invent a
 * relationship between them — at exactly the moment the operator is scanning fastest, first
 * thing in the morning. The whole model is that an answer is tied to its question, so
 * the group key is the sender and the correlation, never the clock.
 *
 * Messages with no correlation id are grouped per sender rather than lumped together:
 * uncorrelated mail from two agents is still two pieces of news.
 */
function groupArrivals(messages: MeshMessage[]): MeshMessage[][] {
  const groups = new Map<string, MeshMessage[]>()
  for (const m of messages) {
    const key = `${m.from}\u0000${m.correlationId ?? ""}`
    const existing = groups.get(key)
    if (existing == null) {
      groups.set(key, [m])
      continue
    }
    existing.push(m)
  }
  return [...groups.values()]
}

/**
 * One arrival, one timeline entry.
 *
 * Collapsed by default: the assistant's recap is what the operator reads, the raw messages sit
 * behind an expandable affordance with their author, type and time. Both live in the
 * SAME entry — a recap and a payload occupying separate slots would double the length
 * of the timeline and make the readability problem worse while technically satisfying
 * "show me the reply".
 *
 * The raw is attached at creation, before the recap exists, so an arrival is never
 * lost to a failed narration — worst case the entry shows its raw and no summary.
 *
 * The mesh stream id IS the entry id, so a replay or re-render cannot produce two
 * copies of the same reply.
 */
function toMeshEntry(entryId: string, messages: MeshMessage[]): UIMessage {
  const raw = messages.map((m) => ({ id: m.id, author: m.from, type: m.type, at: m.ts, correlationId: m.correlationId, text: bodyToText(m.body) }))
  return {
    id: entryId,
    role: "assistant",
    metadata: {
      author: messages[0].from,
      correlationId: messages[0].correlationId,
      meshType: messages[0].type,
      at: messages[0].ts,
      raw,
    },
    // Until the recap streams in, the entry shows the message itself rather than a
    // placeholder — a spinner that never resolves would be worse than the raw text.
    parts: [{ type: "text", text: raw.map((r) => r.text).join("\n\n") }],
  } as UIMessage
}
