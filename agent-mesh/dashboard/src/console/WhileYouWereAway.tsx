// The first thing the operator sees after a night away.
//
// Counted facts only — how many messages, from whom, which of them their own sender
// marked as wanting a human, and which of the operator's questions are still open. No
// summary is generated here on purpose: a model's opinion about forty messages is
// something they would have to audit, and the whole point of this card is that they can
// trust it at a glance. "Catch me up" is right there when they want the opinion, and
// then it is a turn they asked for.

import { ArrowUpRight, Bell, Clock, X } from "lucide-react"
import { relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Digest } from "./useDigest"

export function WhileYouWereAway({ digest, onDismiss, onCatchMeUp }: { digest: Digest; onDismiss: () => void; onCatchMeUp: () => void }) {
  const agents = digest.senders.length
  return (
    <div className="mb-2 w-full rounded-xl border border-border/70 bg-card/80 text-[13px]">
      <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2">
        <Clock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 leading-snug">
          <span className="font-medium">While you were away</span>
          <span className="text-muted-foreground">
            {" · last "}
            {relTime(digest.since)}
          </span>
        </p>
        <button aria-label="Dismiss" className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-lg active:bg-accent" onClick={onDismiss} type="button">
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-2 px-3 py-2.5">
        <p className="leading-snug">
          {digest.arrived === 0 ? (
            "Nothing new arrived."
          ) : (
            <>
              <span className="font-medium tabular">{digest.arrived}</span> message{digest.arrived === 1 ? "" : "s"} from{" "}
              <span className="font-medium tabular">{agents}</span> agent{agents === 1 ? "" : "s"}.
            </>
          )}
        </p>

        {digest.needsYou.length > 0 && (
          <div className="rounded-lg border border-primary/35 bg-primary/10 px-2.5 py-2">
            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary">
              <Bell className="size-3" /> needs you · {digest.needsYou.length}
            </p>
            <ul className="mt-1 flex flex-col gap-1.5">
              {digest.needsYou.slice(0, 4).map((n) => (
                <li className="min-w-0 leading-snug" key={`${n.from}-${n.at}`}>
                  {/* Truncated: mesh ids run to sixty characters and wrapping one costs
                      two lines of a card whose whole job is to be read in one glance. */}
                  <span className="block truncate font-mono text-[11.5px] text-muted-foreground">{n.from}</span>
                  <span className="block text-foreground/85">{n.text}</span>
                </li>
              ))}
            </ul>
            {digest.needsYou.length > 4 && <p className="mt-1 text-[11px] text-muted-foreground">+{digest.needsYou.length - 4} more below.</p>}
          </div>
        )}

        {digest.answered.length > 0 && (
          <p className="leading-snug text-muted-foreground">
            <span className="tabular text-status-online">{digest.answered.length}</span> of your questions came back.
          </p>
        )}

        {digest.waiting.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground/80">Still waiting on</p>
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {digest.waiting.slice(0, 3).map((w) => (
                <li className="flex items-baseline gap-1.5 leading-snug" key={w.correlationId}>
                  <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{w.to}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground/75">{w.asked}</span>
                  <span className="shrink-0 tabular text-[11px] text-muted-foreground/70">{relTime(w.askedAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          className={cn("flex items-center gap-1.5 self-start rounded-full bg-primary/15 px-3 py-1.5 text-[13px] font-medium text-primary active:bg-primary/25")}
          onClick={onCatchMeUp}
          type="button"
        >
          <ArrowUpRight className="size-3.5" /> Catch me up
        </button>
      </div>
    </div>
  )
}
