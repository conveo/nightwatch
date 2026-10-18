import { Fragment } from "react"
import { cn } from "@/lib/utils"

// Mesh payloads are mostly shallow key→value objects, so render them as aligned
// rows (key · value) instead of raw JSON braces — far more scannable in a log.
// Recurses into nested objects/arrays; primitives are typed by color.

function Scalar({ v }: { v: unknown }) {
  if (v === null) {
    return <span className="text-primary/90">null</span>
  }
  if (typeof v === "boolean") {
    return <span className="text-primary/90">{String(v)}</span>
  }
  if (typeof v === "number") {
    return <span className="json-num tabular">{v}</span>
  }
  return <span className="break-words text-foreground/85">{String(v)}</span>
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v !== "object"
}

function Value({ v }: { v: unknown }) {
  if (isScalar(v)) {
    return <Scalar v={v} />
  }
  if (Array.isArray(v)) {
    if (v.length === 0) {
      return <span className="text-muted-foreground/60">empty</span>
    }
    if (v.every(isScalar)) {
      return (
        <div className="flex flex-wrap gap-1">
          {v.map((x, i) => (
            <span key={i} className="rounded border border-border/50 bg-muted/40 px-1.5 py-px text-[11px]">
              <Scalar v={x} />
            </span>
          ))}
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-1.5 border-l border-border/50 pl-2.5">
        {v.map((x, i) => (
          <Value key={i} v={x} />
        ))}
      </div>
    )
  }
  return <KV obj={v as Record<string, unknown>} />
}

function KV({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj)
  if (entries.length === 0) {
    return <span className="text-muted-foreground/60">empty</span>
  }
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {entries.map(([k, v]) => (
        <Fragment key={k}>
          <span className="select-none whitespace-nowrap pt-px text-[11px] text-muted-foreground/80">{k}</span>
          <span className="min-w-0 text-[11.5px] leading-snug">
            <Value v={v} />
          </span>
        </Fragment>
      ))}
    </div>
  )
}

export function JsonView({ body, className }: { body: Record<string, unknown>; className?: string }) {
  return (
    <div
      className={cn(
        "max-h-60 overflow-auto rounded-md border border-border/50 bg-card/40 px-2.5 py-2 font-mono",
        className,
      )}
    >
      <KV obj={body} />
    </div>
  )
}
