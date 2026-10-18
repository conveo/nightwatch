// What happened to a message the operator sent.
//
// The failure this exists for: an agent that is thinking and an agent that never got
// the message look identical in a chat window. That ambiguity leaves the operator
// waiting on a console they start to believe is broken.
//
// Every state here is one the mesh can actually prove. Where it cannot — an agent
// served by another host keeps its read cursor on that host — the answer is "unknown",
// never a cheerful default. A badge that guesses is worse than no badge: the first
// time it says "read" about something that was not, they stop believing all of them.

import { useEffect, useState } from "react"

export type Receipt = {
  delivered: boolean | null
  deliveredReason: "found-in-inbox" | "inbox-unreadable" | "no-request-from-you"
  read: boolean | null
  readReason: "answered-it" | "read-cursor" | "cursor-not-visible"
  readKnown: boolean
  answered: boolean
  answeredAt: string | null
}

// Slow on purpose. This is a reassurance signal, not a data feed — replies arrive over
// the SSE stream and render themselves. One poll every 20s per unanswered ask is
// enough to watch a status change while walking, and the ask list is capped by the
// transcript, so the cost stays flat.
const POLL_MS = 20_000
// Past this an ask stops being something the operator is waiting on. Matches the pending-ask
// window in usePendingAsks, so a card and the waiting list never disagree.
const WATCH_MS = 30 * 60 * 1000

export function useReceipt(args: { correlationId: string; to: string; sentAtMs: number | null }): Receipt | null {
  const { correlationId, to, sentAtMs } = args
  const [receipt, setReceipt] = useState<Receipt | null>(null)

  useEffect(() => {
    if (correlationId === "" || to === "") {
      return
    }
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/console/receipts?correlationId=${encodeURIComponent(correlationId)}&to=${encodeURIComponent(to)}`)
        if (!res.ok || !live) {
          return
        }
        const r = (await res.json()) as Receipt
        if (!live) {
          return
        }
        setReceipt(r)
        // An answered ask is finished: nothing it reports can change again, so the
        // poll stops rather than running for the rest of the session.
        if (r.answered) {
          return
        }
        // Stop watching an old ask on its own, rather than relying on the component
        // unmounting. A phone left open on one conversation never unmounts anything.
        if (sentAtMs != null && Date.now() - sentAtMs > WATCH_MS) {
          return
        }
        timer = setTimeout(() => void poll(), POLL_MS)
      } catch {
        // A failed probe means unknown, which is what `receipt` already says. Retrying
        // forever on a console whose server is down would just burn battery.
      }
    }

    void poll()
    return () => {
      live = false
      if (timer != null) {
        clearTimeout(timer)
      }
    }
  }, [correlationId, to, sentAtMs])

  return receipt
}

/** One short phrase, and whether it is good news, bad news or an honest shrug. */
export function receiptLabel(r: Receipt): { text: string; tone: "good" | "waiting" | "unknown" } {
  if (r.answered) {
    const at = r.answeredAt != null ? new Date(r.answeredAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null
    return { text: at != null ? `answered ${at}` : "answered", tone: "good" }
  }
  if (r.delivered !== true) {
    return {
      text: r.deliveredReason === "inbox-unreadable" ? "can't reach that inbox" : "no send record",
      tone: "unknown",
    }
  }
  if (!r.readKnown) {
    return { text: "delivered · read unknown on that host", tone: "unknown" }
  }
  return r.read === true ? { text: "read, no reply yet", tone: "waiting" } : { text: "delivered, not read yet", tone: "waiting" }
}
