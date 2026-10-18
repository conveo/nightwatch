import { Activity, Check, ChevronDown, Layers, Search, Server, Tag, X } from "lucide-react"
import type { ComponentType } from "react"
import type { AgentStatus } from "@/lib/api"
import { activeFilterCount, EMPTY_FILTERS, type Facet, type Filters, type GroupBy } from "@/lib/filters"
import { usePersistedState } from "@/lib/usePersistedState"
import { cn } from "@/lib/utils"
import { Badge, Input, STATUS_COLOR } from "./ui/core"

const STATUSES: AgentStatus[] = ["online", "dead", "stale", "offline"]

type SectionKey = "hosts" | "scope" | "status" | "role"

type Props = {
  filters: Filters
  setFilters: (f: Filters) => void
  facets: { hosts: Facet[]; scopes: Facet[]; roles: Facet[] }
  groupBy: GroupBy
  setGroupBy: (g: GroupBy) => void
  shown: number
  total: number
}

// Inline faceted filtering: each dimension is a collapsible section of toggle
// rows with live counts, right in the sidebar — no popovers, no hunting. Section
// open-state is remembered.
export function FilterPanel({ filters, setFilters, facets, groupBy, setGroupBy, shown, total }: Props) {
  const [open, setOpen] = usePersistedState<Record<SectionKey, boolean>>("facets-open", {
    hosts: true,
    scope: false,
    status: false,
    role: false,
  })
  const toggleSection = (k: SectionKey) => setOpen((o) => ({ ...o, [k]: !o[k] }))
  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const active = activeFilterCount(filters)

  return (
    <div className="flex flex-col border-b border-border/70">
      {/* search */}
      <div className="relative p-2.5 pb-1.5">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
        <Input
          value={filters.query}
          onChange={(e) => setFilters({ ...filters, query: e.target.value })}
          placeholder="Filter by id or role…"
          className="h-9 pl-8 font-mono text-[13px]"
        />
        {filters.query !== "" && (
          <button
            onClick={() => setFilters({ ...filters, query: "" })}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* faceted sections (bounded so the roster always keeps room) */}
      <div className="max-h-[44vh] overflow-y-auto px-1.5 pb-1">
        <Section title="Hosts" icon={Server} count={filters.hosts.length} open={open.hosts} onToggle={() => toggleSection("hosts")}>
          {facets.hosts.map((h) => (
            <Row
              key={h.value}
              active={filters.hosts.includes(h.value)}
              onClick={() => setFilters({ ...filters, hosts: toggle(filters.hosts, h.value) })}
              label={h.value}
              meta={`${h.online}/${h.count}`}
            />
          ))}
        </Section>

        <Section title="Scope" icon={Layers} count={filters.scope != null ? 1 : 0} open={open.scope} onToggle={() => toggleSection("scope")}>
          <Row radio active={filters.scope == null} onClick={() => setFilters({ ...filters, scope: null })} label="all scopes" muted />
          {facets.scopes.map((s) => (
            <Row
              key={s.value}
              radio
              active={filters.scope === s.value}
              onClick={() => setFilters({ ...filters, scope: filters.scope === s.value ? null : s.value })}
              label={`${s.value}.*`}
              meta={`${s.online}/${s.count}`}
            />
          ))}
          {facets.scopes.length === 0 && <p className="px-2 py-1.5 text-[11px] text-muted-foreground/70">No shared scopes</p>}
        </Section>

        <Section title="Status" icon={Activity} count={filters.statuses.length} open={open.status} onToggle={() => toggleSection("status")}>
          {STATUSES.map((st) => (
            <Row
              key={st}
              active={filters.statuses.includes(st)}
              onClick={() => setFilters({ ...filters, statuses: toggle(filters.statuses, st) })}
              label={st}
              dot={STATUS_COLOR[st]}
            />
          ))}
        </Section>

        {facets.roles.length > 1 && (
          <Section title="Role" icon={Tag} count={filters.roles.length} open={open.role} onToggle={() => toggleSection("role")}>
            {facets.roles.map((r) => (
              <Row
                key={r.value}
                active={filters.roles.includes(r.value)}
                onClick={() => setFilters({ ...filters, roles: toggle(filters.roles, r.value) })}
                label={r.value}
                meta={String(r.count)}
              />
            ))}
          </Section>
        )}
      </div>

      {/* footer: grouping · count · clear */}
      <div className="flex items-center gap-2 border-t border-border/50 px-2.5 py-1.5">
        <div className="flex items-center overflow-hidden rounded-md border border-border/70">
          {(["host", "scope"] as GroupBy[]).map((g) => (
            <button
              key={g}
              onClick={() => setGroupBy(g)}
              className={cn(
                "px-2 py-0.5 text-[10.5px] capitalize transition-colors",
                groupBy === g ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              title={`Group roster by ${g}`}
            >
              {g}
            </button>
          ))}
        </div>
        {active > 0 && (
          <button
            onClick={() => setFilters({ ...EMPTY_FILTERS })}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3" /> clear
          </button>
        )}
        <span className="ml-auto tabular text-[11px] text-muted-foreground">
          <span className="text-foreground">{shown}</span>/{total}
        </span>
      </div>
    </div>
  )
}

function Section({
  title,
  icon: Icon,
  count,
  open,
  onToggle,
  children,
}: {
  title: string
  icon: ComponentType<{ className?: string }>
  count: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon className="size-3.5" />
        {title}
        {count > 0 && <Badge variant="primary">{count}</Badge>}
        <ChevronDown className={cn("ml-auto size-3.5 opacity-60 transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="pb-1 pl-1">{children}</div>}
    </div>
  )
}

function Row({
  active,
  onClick,
  label,
  meta,
  dot,
  radio = false,
  muted = false,
}: {
  active: boolean
  onClick: () => void
  label: string
  meta?: string
  dot?: string
  radio?: boolean
  muted?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/50",
        active && "bg-accent/40",
      )}
    >
      {radio ? (
        <span className={cn("grid size-3.5 shrink-0 place-items-center rounded-full border", active ? "border-primary" : "border-border/70")}>
          {active && <span className="size-1.5 rounded-full bg-primary" />}
        </span>
      ) : (
        <span
          className={cn(
            "grid size-3.5 shrink-0 place-items-center rounded-[4px] border transition-colors",
            active ? "border-primary bg-primary text-primary-foreground" : "border-border/70",
          )}
        >
          {active && <Check className="size-2.5 stroke-[3]" />}
        </span>
      )}
      {dot != null && <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: dot }} />}
      <span className={cn("flex-1 truncate font-mono text-[11.5px]", muted && "text-muted-foreground")}>{label}</span>
      {meta != null && <span className="tabular text-[10px] text-muted-foreground/70">{meta}</span>}
    </button>
  )
}
