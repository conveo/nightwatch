import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  ListFilter,
  MessageSquarePlus,
  Radio,
  RadioTower,
  Server,
  Trash2,
} from "lucide-react"
import { Fragment, useEffect, useMemo, useState } from "react"
import { type AgentRecord, api, type Inspection, type MeshMessage } from "@/lib/api"
import { bodyPreview, clockTime, dayLabel, relTime, sameDay, TYPE_STYLE } from "@/lib/format"
import { markSeen } from "@/lib/useMesh"
import { usePersistedState } from "@/lib/usePersistedState"
import { cn } from "@/lib/utils"
import { JsonView } from "./JsonView"
import { Checkbox } from "./ui/checkbox"
import { Badge, Button, Input, StatusDot, STATUS_COLOR } from "./ui/core"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"

type Props = {
  id: string | null
  agent: AgentRecord | undefined
  onComposeTo: (id: string) => void
  onUnregister: (id: string) => void
}

const msgKey = (m: MeshMessage) => `${m.channel}:${m.id}`

export function DetailPane({ id, agent, onComposeTo, onUnregister }: Props) {
  const [data, setData] = useState<Inspection | null>(null)
  const [loading, setLoading] = useState(false)
  // expanded message keys; empty = all collapsed (the default).
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  const [fromFilter, setFromFilter] = useState<Set<string>>(new Set())
  const [hideBroadcast, setHideBroadcast] = usePersistedState("hide-broadcast", false) // viewing preference — persists

  useEffect(() => {
    if (id == null) {
      setData(null)
      return
    }
    setOpenIds(new Set()) // collapse all when switching agent/channel
    setFromFilter(new Set()) // senders are per-agent
    let live = true
    const load = () => {
      api
        .inspect(id)
        .then((d) => {
          if (!live) {
            return
          }
          setData(d)
          if (d.history.length > 0) {
            markSeen(id, d.history[d.history.length - 1].id)
          }
        })
        .catch(() => {
          // daemon dropped mid-session: the topbar already shows "daemon
          // unreachable" (via useMesh's health poll), so keep the last-known
          // messages instead of flashing the pane empty. Handling the rejection
          // here just stops it going unhandled every tick; the next good tick
          // repopulates.
        })
        .finally(() => live && setLoading(false))
    }
    setLoading(true)
    load()
    const t = setInterval(load, 4000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [id])

  const history = data?.history ?? []
  const senders = useMemo(() => {
    const map = new Map<string, number>()
    for (const m of data?.history ?? []) {
      map.set(m.from, (map.get(m.from) ?? 0) + 1)
    }
    return [...map.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  }, [data])

  const hasBroadcast = id !== "broadcast" && history.some((m) => m.to === "broadcast")
  const visible = history.filter(
    (m) => (fromFilter.size === 0 || fromFilter.has(m.from)) && !(hideBroadcast && m.to === "broadcast"),
  )
  const visibleKeys = visible.map(msgKey)
  const allOpen = visible.length > 0 && visibleKeys.every((k) => openIds.has(k))
  const toggleAll = () => setOpenIds(allOpen ? new Set() : new Set(visibleKeys))
  const toggleOne = (k: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev)
      next.has(k) ? next.delete(k) : next.add(k)
      return next
    })

  if (id == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="grid size-12 place-items-center rounded-xl border border-border/60 bg-card/40">
          <Radio className="size-5 text-muted-foreground/60" />
        </div>
        <div>
          <p className="text-sm text-foreground/80">Select an agent or channel</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Inspect its delivered messages, metadata, and live status.</p>
        </div>
      </div>
    )
  }

  const isBroadcast = id === "broadcast"

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="border-b border-border/70 p-4">
        <div className="flex items-start gap-3">
          {isBroadcast ? (
            <Radio className="mt-1 size-4 text-primary" />
          ) : agent != null ? (
            <span className="mt-1.5">
              <StatusDot status={agent.status} />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-mono text-[15px] font-medium">{id}</h2>
              <button
                onClick={() => navigator.clipboard?.writeText(id)}
                className="text-muted-foreground/60 transition-colors hover:text-foreground"
                title="Copy id"
              >
                <Copy className="size-3.5" />
              </button>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isBroadcast ? (
                "mesh-wide broadcast channel"
              ) : agent != null ? (
                <>
                  <span className="capitalize" style={{ color: STATUS_COLOR[agent.status] }}>
                    {agent.status}
                  </span>
                  {" · "}
                  {agent.role}
                  {agent.host != null && ` · ${agent.host}`}
                  {" · seen "}
                  {relTime(agent.lastSeen)} ago
                </>
              ) : (
                "not in the current roster"
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => onComposeTo(id)}>
              <MessageSquarePlus className="size-3.5" /> Message
            </Button>
            {!isBroadcast && agent != null && (
              <Button variant="ghost" size="iconSm" title="Unregister (one-offs only)" onClick={() => onUnregister(id)}>
                <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
              </Button>
            )}
          </div>
        </div>

        {/* meta */}
        {agent != null && Object.keys(agent.meta).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {Object.entries(agent.meta).map(([k, v]) => (
              <span key={k} className="rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 font-mono text-[10.5px]">
                <span className="text-muted-foreground">{k}</span>
                <span className="text-muted-foreground/50">=</span>
                <span className="text-foreground/90">{String(v)}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* messages toolbar — filters + expand control */}
      {history.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-1.5">
          {senders.length > 1 && <FromFilter senders={senders} selected={fromFilter} onChange={setFromFilter} />}
          {hasBroadcast && (
            <button
              onClick={() => setHideBroadcast((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
                hideBroadcast
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
              title="Hide mesh-wide broadcast messages"
            >
              <RadioTower className="size-3" />
              {hideBroadcast ? "broadcasts hidden" : "hide broadcasts"}
            </button>
          )}
          <span className="ml-auto tabular text-[11px] text-muted-foreground">
            {visible.length === history.length
              ? `${history.length} message${history.length === 1 ? "" : "s"}`
              : `${visible.length} / ${history.length}`}
          </span>
          {visible.length > 0 && (
            <button
              onClick={toggleAll}
              className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {allOpen ? <ChevronsDownUp className="size-3" /> : <ChevronsUpDown className="size-3" />}
              {allOpen ? "collapse all" : "expand all"}
            </button>
          )}
        </div>
      )}

      {/* messages */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length > 0 ? (
          <div className="flex flex-col px-4 pb-6">
            {[...visible].reverse().map((m, i, arr) => {
              const k = msgKey(m)
              const newDay = i === 0 || !sameDay(m.ts, arr[i - 1].ts)
              const lastOfDay = i === arr.length - 1 || !sameDay(m.ts, arr[i + 1].ts)
              return (
                <Fragment key={k}>
                  {newDay && (
                    <div className="sticky top-0 z-20 -mx-4 mb-1 flex items-center gap-2 bg-background/95 px-4 py-1.5 backdrop-blur">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">{dayLabel(m.ts)}</span>
                      <span className="h-px flex-1 bg-border/50" />
                    </div>
                  )}
                  <MessageRow m={m} last={lastOfDay} open={openIds.has(k)} onToggle={() => toggleOne(k)} />
                </Fragment>
              )
            })}
          </div>
        ) : (
          <p className="px-4 py-10 text-center text-xs text-muted-foreground">
            {loading ? "Loading…" : history.length > 0 ? "No messages match these filters." : "No delivered messages."}
          </p>
        )}
      </div>
    </div>
  )
}

// One event on a left timeline rail: a type-colored node and a calm monospace
// header (▸ time · type · FROM → TO · corr). Collapsed by default with a one-line
// payload teaser; expands to the full structured key/value view.
function MessageRow({
  m,
  last,
  open,
  onToggle,
}: {
  m: MeshMessage
  last: boolean
  open: boolean
  onToggle: () => void
}) {
  const style = TYPE_STYLE[m.type]
  const hasBody = Object.keys(m.body).length > 0

  return (
    <div className="group relative flex gap-3">
      <div className="relative flex w-2 shrink-0 justify-center">
        {!last && <span className="absolute top-3 bottom-[-0.5rem] w-px bg-border/60" />}
        <span
          className="relative z-10 mt-[4px] size-[7px] rounded-full ring-4 ring-background"
          style={{ backgroundColor: style.color }}
        />
      </div>

      <div className="min-w-0 flex-1 pb-3">
        <button
          onClick={hasBody ? onToggle : undefined}
          className={cn("flex w-full items-baseline gap-2 text-left text-[11px] leading-tight", hasBody && "cursor-pointer")}
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 self-center text-muted-foreground/45 transition-transform",
              open && "rotate-90",
              !hasBody && "invisible",
            )}
          />
          <span className="shrink-0 tabular font-mono text-muted-foreground/70">{clockTime(m.ts)}</span>
          <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider" style={{ color: style.color }}>
            {style.label}
          </span>
          <span className="flex min-w-0 items-center gap-1 font-mono">
            <span className="msg-from truncate">{m.from}</span>
            <span className="shrink-0 text-muted-foreground/40">→</span>
            <Recipient to={m.to} />
          </span>
          {m.correlationId != null && (
            <span className="ml-auto shrink-0 rounded border border-border/50 px-1 font-mono text-[9.5px] text-muted-foreground/70">
              {m.correlationId}
            </span>
          )}
          <span className={cn("shrink-0 tabular text-[10px] text-muted-foreground/50", m.correlationId == null && "ml-auto")}>
            {relTime(m.ts)}
          </span>
        </button>
        {hasBody &&
          (open ? (
            <JsonView body={m.body} className="mt-1.5 ml-5" />
          ) : (
            <button onClick={onToggle} className="mt-0.5 block w-full truncate pl-5 text-left font-mono text-[11px] text-muted-foreground/55">
              {bodyPreview(m.body)}
            </button>
          ))}
      </div>
    </div>
  )
}

// The recipient reads differently by kind: a specific agent (green), a host
// fan-out, or the mesh-wide broadcast channel — the last two aren't agents, so
// they get an icon and a de-emphasized treatment.
function Recipient({ to }: { to: string }) {
  if (to === "broadcast") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted/60 px-1 text-[10.5px] text-muted-foreground/90">
        <Radio className="size-2.5" /> broadcast
      </span>
    )
  }
  if (to.startsWith("host:")) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground/85">
        <Server className="size-2.5 shrink-0" /> <span className="truncate">{to.slice(5)}</span>
      </span>
    )
  }
  return <span className="msg-to truncate">{to}</span>
}

function FromFilter({
  senders,
  selected,
  onChange,
}: {
  senders: { value: string; count: number }[]
  selected: Set<string>
  onChange: (s: Set<string>) => void
}) {
  const [q, setQ] = useState("")
  const list = senders.filter((s) => s.value.toLowerCase().includes(q.toLowerCase()))
  const toggle = (v: string) => {
    const n = new Set(selected)
    n.has(v) ? n.delete(v) : n.add(v)
    onChange(n)
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn(selected.size > 0 && "border-primary/40 text-foreground")}>
          <ListFilter className="size-3.5" />
          From
          {selected.size > 0 && <Badge variant="primary">{selected.size}</Badge>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <div className="border-b border-border/60 p-1.5">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter senders…"
            className="h-7 font-mono text-xs"
            autoFocus
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {list.map((s) => (
            <button
              key={s.value}
              onClick={() => toggle(s.value)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/60"
            >
              <Checkbox checked={selected.has(s.value)} className="pointer-events-none" />
              <span className="flex-1 truncate font-mono text-xs">{s.value}</span>
              <span className="tabular text-[10.5px] text-muted-foreground">{s.count}</span>
            </button>
          ))}
          {list.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">No senders</p>}
        </div>
        {selected.size > 0 && (
          <div className="border-t border-border/60 p-1">
            <Button variant="ghost" size="sm" className="w-full text-[11px]" onClick={() => onChange(new Set())}>
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
