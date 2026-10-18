import type { MeshMessage } from "./api"

export function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

export function dayLabel(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) {
    return "—"
  }
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) {
    return "Today"
  }
  if (d.toDateString() === yesterday.toDateString()) {
    return "Yesterday"
  }
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === today.getFullYear()
      ? { weekday: "short", day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" }
  return d.toLocaleDateString("en-GB", opts)
}

export function clockTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) {
    return "--:--:--"
  }
  return d.toLocaleTimeString("en-GB", { hour12: false })
}

export function relTime(ts: string): string {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60) {
    return `${Math.floor(s)}s`
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m`
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)}h`
  }
  return `${Math.floor(s / 86400)}d`
}

// Per-message-type color (text + subtle bg), keyed off the semantic palette.
export const TYPE_STYLE: Record<MeshMessage["type"], { color: string; label: string }> = {
  blocker: { color: "var(--status-dead)", label: "blocker" },
  decision: { color: "var(--status-online)", label: "decision" },
  result: { color: "var(--status-online)", label: "result" },
  request: { color: "var(--status-stale)", label: "request" },
  status: { color: "oklch(0.7 0.1 240)", label: "status" },
  note: { color: "var(--status-offline)", label: "note" },
}

// A compact one-line teaser of a payload for a collapsed log entry.
export function bodyPreview(body: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(body)) {
    let s: string
    if (v === null) {
      s = "null"
    } else if (Array.isArray(v)) {
      s = `[${v.length}]`
    } else if (typeof v === "object") {
      s = "{…}"
    } else {
      s = String(v)
    }
    parts.push(`${k} ${s}`)
    if (parts.join("   ").length > 140) {
      break
    }
  }
  return parts.join("   ")
}
