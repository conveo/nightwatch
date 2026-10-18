// The notifications opt-in, shown in the console's footer.
//
// It states the iOS Home Screen requirement plainly instead of offering a button
// that would silently fail there — the one step in this whole feature that only
// the operator can perform.

import { Bell, BellOff, BellRing, Loader2, Share, TriangleAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import { usePushOptIn } from "./usePushOptIn"

export function PushOptIn({ className }: { className?: string }) {
  const { state, enable, disable, busy } = usePushOptIn()

  if (state.kind === "unsupported") {
    return null // nothing actionable to offer; a dead control is worse than none
  }

  if (state.kind === "needs-install") {
    return (
      <p className={cn("flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground", className)}>
        <Share className="mt-px size-3 shrink-0" />
        <span>
          To get answers when this tab is closed: <span className="text-foreground">Share → Add to Home Screen</span>, then open the console from there and turn
          notifications on.
        </span>
      </p>
    )
  }

  if (state.kind === "blocked") {
    return (
      <p className={cn("flex items-center gap-1.5 text-[11px] text-muted-foreground", className)}>
        <BellOff className="size-3 shrink-0" /> Notifications are blocked for this site in your browser settings.
      </p>
    )
  }

  // A pruned subscription is not the same as "off", and it must not render as one.
  // Off is a choice the operator made; this is the feature having stopped working without
  // anything being said — the phone goes quiet and the toggle still looks fine. So it
  // says what happened and what the one tap will do, in the failure's own colour.
  if (state.kind === "stale") {
    return (
      <button
        className={cn("flex items-center gap-1.5 rounded-full px-2 py-1 text-left text-[11px] leading-snug text-destructive transition-colors hover:text-destructive/80", className)}
        disabled={busy}
        onClick={() => void enable()}
        type="button"
      >
        {busy ? <Loader2 className="size-3 shrink-0 animate-spin" /> : <TriangleAlert className="size-3 shrink-0" />}
        Notifications stopped reaching this device — tap to turn them back on
      </button>
    )
  }

  const on = state.kind === "subscribed"
  return (
    <button
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] transition-colors",
        on ? "text-primary" : "text-muted-foreground hover:text-foreground",
        className,
      )}
      disabled={busy}
      onClick={() => void (on ? disable() : enable())}
      type="button"
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : on ? <BellRing className="size-3" /> : <Bell className="size-3" />}
      {on ? `Notifications on${state.devices > 1 ? ` · ${state.devices} devices` : ""}` : "Notify me when answers arrive"}
    </button>
  )
}
