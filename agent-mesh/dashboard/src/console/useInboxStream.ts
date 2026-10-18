// Subscribe once, at the shell, to everything arriving in the operator's mesh inbox.
//
// Mounted by the shell rather than by a view: a per-view subscription would open a
// second stream every time they switched tabs, and would go deaf the moment they were
// looking at something else — which is exactly when an answer is most likely to land.

import { useEffect, useRef, useState } from "react"
import type { MeshMessage } from "@/lib/api"

export type InboxArrival = { messages: MeshMessage[]; at: number }

// A burst of related messages should become ONE narration, not four in a row. The
// window is short enough that a single message still feels immediate.
const BATCH_MS = 1200
// Comfortably inside the server's 45s presence window, so one dropped beacon does not
// make a watching console look absent.
const PRESENCE_MS = 15_000

export function useInboxStream(): { arrival: InboxArrival | null; connected: boolean } {
  const [arrival, setArrival] = useState<InboxArrival | null>(null)
  const [connected, setConnected] = useState(false)
  // Messages seen but not yet released, and the ids already released. Dedup is by
  // channel+id per the delivery contract — notification count is not identity.
  //
  // The released set is PERSISTED. In memory alone it survives an EventSource
  // auto-reconnect but not a reload, and iOS Safari discards background tabs hard
  // enough that returning to the console is a reload far more often than on desktop.
  // If the server ever does hand a new connection a backlog, an unpersisted set turns
  // that into a narration of things they have already read — old news presented as new,
  // which is worse than silence.
  const pending = useRef<MeshMessage[]>([])
  const seen = useRef<Set<string>>(loadSeen())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Presence beacon: only while the tab is actually on screen. This is what decides
  // whether an arrival narrates quietly or buzzes their phone, so it must mean "they are
  // looking", not "a socket exists" — a backgrounded tab holds a socket open and is
  // exactly when a notification IS wanted.
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState !== "visible") {
        return
      }
      void fetch("/api/console/presence", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => undefined)
    }
    beat()
    const t = setInterval(beat, PRESENCE_MS)
    document.addEventListener("visibilitychange", beat)
    return () => {
      clearInterval(t)
      document.removeEventListener("visibilitychange", beat)
    }
  }, [])

  useEffect(() => {
    const es = new EventSource("/api/console/events")
    es.addEventListener("ready", () => setConnected(true))
    es.addEventListener("inbox", (e) => {
      let parsed: { messages?: MeshMessage[] }
      try {
        parsed = JSON.parse((e as MessageEvent<string>).data) as { messages?: MeshMessage[] }
      } catch {
        return
      }
      const incoming = parsed.messages ?? []
      const fresh = incoming.filter((m) => {
        const key = `${m.channel}:${m.id}`
        if (seen.current.has(key)) {
          return false
        }
        seen.current.add(key)
        return true
      })
      saveSeen(seen.current)
      // A drop is a DECISION and it has to be visible. The released-id set is now
      // persisted, so a bug here would suppress a message permanently across reloads —
      // the failure would look exactly like the mesh never delivering it.
      if (fresh.length < incoming.length) {
        reportClientEvent("dropped-as-seen", incoming.filter((m) => !fresh.includes(m)).map((m) => m.id))
      }
      if (fresh.length === 0) {
        return
      }
      pending.current = [...pending.current, ...fresh]
      if (timer.current != null) {
        clearTimeout(timer.current)
      }
      timer.current = setTimeout(() => {
        const batch = pending.current
        pending.current = []
        timer.current = null
        if (batch.length > 0) {
          setArrival({ messages: batch, at: Date.now() })
        }
      }, BATCH_MS)
    })
    // EventSource reconnects on its own; the flag just stops the UI claiming a live
    // feed while the server is down.
    es.onerror = () => setConnected(false)
    return () => {
      es.close()
      if (timer.current != null) {
        clearTimeout(timer.current)
      }
    }
  }, [])

  return { arrival, connected }
}

// Bounded so the key cannot grow without limit on a console that runs for weeks;
// only the most recent ids can plausibly be replayed to a reconnecting client.
const SEEN_KEY = "agent-mesh:console-seen"
const SEEN_CAP = 300

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    return new Set(raw != null ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set() // private mode / cleared storage — degrade, never throw
  }
}

function saveSeen(seen: Set<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_CAP)))
  } catch {
    /* quota or private mode — dedup falls back to per-session, which still works */
  }
}

/**
 * Tell the server what the browser decided. The server can log what IT did; only the
 * client knows what it chose to drop, so without this "never narrated" and "narrated
 * and failed" are indistinguishable in the log. Ids and reasons only — never bodies.
 */
export function reportClientEvent(event: string, ids: string[], detail?: string): void {
  void fetch("/api/console/client-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({ event, ids, detail: detail ?? null }),
  }).catch(() => undefined)
}
