// "While you were away", and the one piece of state it needs: when this browser last
// had the console on screen.
//
// Per-surface on purpose. The server cannot answer "when did YOU last look" — the
// phone and the laptop are away at different times, and a server-side last-seen would
// mean opening the laptop erased the phone's morning digest.

import { useEffect, useRef, useState } from "react"

export type DigestAsk = { correlationId: string; to: string; asked: string; askedAt: string; answeredAt: string | null }

export type Digest = {
  since: string
  arrived: number
  senders: { id: string; count: number; lastAt: string; lastType: string }[]
  needsYou: { from: string; at: string; type: string; correlationId: string | null; text: string }[]
  answered: DigestAsk[]
  waiting: DigestAsk[]
}

const LAST_SEEN_KEY = "agent-mesh:console-last-seen"
// Below this it was a tab switch, a phone call, a lock screen — not an absence. A
// digest that appears every time the operator glances away is chrome, and they stop reading it,
// which costs the one morning it was built for.
const AWAY_MS = 45 * 60 * 1000
// How often the mark is refreshed while they are watching. Frequent enough that a crash
// or a force-quit does not make the next open look like an absence.
const MARK_MS = 60 * 1000

function readLastSeen(): number | null {
  try {
    const raw = localStorage.getItem(LAST_SEEN_KEY)
    const n = raw != null ? Number.parseInt(raw, 10) : Number.NaN
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, String(Date.now()))
  } catch {
    /* private mode — the digest just never triggers, which is the safe direction */
  }
}

// Captured at MODULE LOAD, which is once per page load, before any component mounts.
// A ref inside the hook is not enough: the console remounts (a view change, a
// conversation switch), and by the second mount the first mount's effect has already
// written a fresh mark — so the absence measures itself against a timestamp this very
// page wrote, and the digest never appears. That failure is silent and only shows up
// on the morning it was built for.
const AWAY_SINCE = readLastSeen()

export function useDigest(conversationId: string): { digest: Digest | null; dismiss: () => void } {
  const [digest, setDigest] = useState<Digest | null>(null)
  const awaySince = useRef<number | null>(AWAY_SINCE)

  useEffect(() => {
    markSeen()
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        markSeen()
      }
    }, MARK_MS)
    // Also on the way out, so a deliberate close records a fresh mark rather than
    // leaving up to a minute of drift that reads as extra absence.
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        markSeen()
      }
    }
    document.addEventListener("visibilitychange", onHide)
    return () => {
      clearInterval(t)
      document.removeEventListener("visibilitychange", onHide)
    }
  }, [])

  useEffect(() => {
    const since = awaySince.current
    // A recent mark means they never left — a tab switch, not an absence.
    if (since != null && Date.now() - since < AWAY_MS) {
      return
    }
    // No mark at all is NOT a reason to skip: a browser that was just updated, or a
    // second device, has none — and that is precisely the first open where a digest is
    // worth most. `since` is omitted and the server falls back to when the conversation
    // was last written, answering the same question from the side it can see. A console
    // that has never been used anywhere gets an empty digest and nothing renders.
    const sinceParam = since != null ? `since=${encodeURIComponent(new Date(since).toISOString())}&` : ""
    let live = true
    void fetch(`/api/console/digest?${sinceParam}conversation=${encodeURIComponent(conversationId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Digest | null) => {
        if (!live || d == null) {
          return
        }
        // Nothing arrived and nothing is outstanding: they missed nothing, so say
        // nothing. An empty digest card is worse than no card — it makes the absence
        // itself the news.
        if (d.arrived === 0 && d.waiting.length === 0) {
          return
        }
        setDigest(d)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [conversationId])

  return { digest, dismiss: () => setDigest(null) }
}
