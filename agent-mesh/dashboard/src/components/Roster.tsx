import { Radio } from "lucide-react"
import { useMemo } from "react"
import type { Activity, AgentRecord, LocalAgent } from "@/lib/api"
import { type Facet, type GroupBy, groupKey } from "@/lib/filters"
import { getSeen, lastActivityFor, streamIdGt } from "@/lib/useMesh"
import { cn } from "@/lib/utils"
import { Badge, StatusDot } from "./ui/core"

type Props = {
  agents: AgentRecord[]
  groupBy: GroupBy
  scopes: Facet[]
  local: LocalAgent[]
  activity: Activity | null
  selectedId: string | null
  onSelect: (id: string) => void
}

// Render an agent id with the leaf segment emphasized and the namespace muted.
function ScopedId({ id }: { id: string }) {
  const dot = id.lastIndexOf(".")
  if (dot < 0) {
    return <span className="text-foreground">{id}</span>
  }
  return (
    <>
      <span className="text-muted-foreground/80">{id.slice(0, dot + 1)}</span>
      <span className="text-foreground">{id.slice(dot + 1)}</span>
    </>
  )
}

export function Roster({ agents, groupBy, scopes, local, activity, selectedId, onSelect }: Props) {
  const seen = getSeen()
  const groups = useMemo(() => {
    const map = new Map<string, AgentRecord[]>()
    for (const a of agents) {
      const k = groupKey(a, groupBy, scopes)
      const arr = map.get(k) ?? []
      arr.push(a)
      map.set(k, arr)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [agents, groupBy, scopes])

  if (agents.length === 0) {
    return <p className="px-4 py-10 text-center text-xs text-muted-foreground">No agents match these filters.</p>
  }

  return (
    <div className="py-1">
      {groups.map(([group, rows]) => {
        const online = rows.filter((r) => r.status === "online").length
        return (
          <div key={group} className="mb-0.5">
            <div className="sticky top-0 z-10 flex items-center gap-2 bg-background/95 px-3 py-1.5 backdrop-blur">
              <span className="truncate font-mono text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground" title={group}>
                {group}
              </span>
              <span className="h-px flex-1 bg-border/50" />
              <span className="tabular text-[10px] text-muted-foreground/70">
                {online}/{rows.length}
              </span>
            </div>
            {rows.map((a) => {
              const localInfo = local.find((l) => l.id === a.id)
              const unread = localInfo != null ? localInfo.unread : 0
              const isNew = unread === 0 && streamIdGt(lastActivityFor(a, activity), seen[a.id] ?? "0")
              return (
                <button
                  key={a.id}
                  onClick={() => onSelect(a.id)}
                  className={cn(
                    "group flex w-full items-center gap-2.5 border-l-2 px-3 py-1.5 text-left transition-colors",
                    selectedId === a.id
                      ? "border-l-primary bg-accent/70"
                      : "border-l-transparent hover:border-l-border hover:bg-accent/40",
                  )}
                >
                  <StatusDot status={a.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12.5px] leading-tight">
                      <ScopedId id={a.id} />
                    </span>
                    <span className="block truncate text-[10.5px] leading-tight text-muted-foreground">{a.role}</span>
                  </span>
                  {unread > 0 ? (
                    <Badge variant="primary" className="tabular">
                      {unread}
                    </Badge>
                  ) : isNew ? (
                    <span className="size-1.5 rounded-full bg-primary" title="new traffic since you last looked" />
                  ) : null}
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

export function ChannelsRow({ selectedId, onSelect, isNew }: { selectedId: string | null; onSelect: (id: string) => void; isNew: boolean }) {
  return (
    <button
      onClick={() => onSelect("broadcast")}
      className={cn(
        "flex w-full items-center gap-2.5 border-l-2 px-3 py-2 text-left transition-colors",
        selectedId === "broadcast" ? "border-l-primary bg-accent/70" : "border-l-transparent hover:bg-accent/40",
      )}
    >
      <Radio className="size-3.5 text-primary" />
      <span className="flex-1 font-mono text-[12.5px]">broadcast</span>
      {isNew && <span className="size-1.5 rounded-full bg-primary" />}
    </button>
  )
}
