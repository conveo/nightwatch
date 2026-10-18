import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "@/lib/api"
import { deriveFacets, EMPTY_FILTERS, type Filters, filterAgents, type GroupBy } from "@/lib/filters"
import { getSeen, lastActivityFor, markSeen, streamIdGt, useMesh } from "@/lib/useMesh"
import { usePersistedState } from "@/lib/usePersistedState"
import { DesktopConsole } from "@/console/DesktopConsole"
import { useDesktopView } from "@/lib/useDesktopView"
import { Composer } from "@/components/Composer"
import { DetailPane } from "@/components/DetailPane"
import { FilterPanel } from "@/components/FilterPanel"
import { PlansView } from "@/components/PlansView"
import { ChannelsRow, Roster } from "@/components/Roster"
import { Topbar } from "@/components/Topbar"
import { Separator } from "@/components/ui/core"

const SIDEBAR_MIN = 248
const SIDEBAR_MAX = 600

export default function App() {
  const mesh = useMesh()
  const [filters, setFilters] = usePersistedState<Filters>("filters", EMPTY_FILTERS)
  const [groupBy, setGroupBy] = usePersistedState<GroupBy>("group-by", "host")
  const [selectedId, setSelectedId] = usePersistedState<string | null>("selected", null)
  const [sidebarWidth, setSidebarWidth] = usePersistedState<number>("sidebar-width", 340)
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeTo, setComposeTo] = useState<string | null>(null)
  const [view, setView] = useDesktopView()
  // Deep-link: ?view=plans&plan=<path>&to=<id> (used by /nightwatch to link a plan).
  const [planParam] = useState<string | null>(() => new URLSearchParams(window.location.search).get("plan"))
  const [toParam] = useState<string>(() => new URLSearchParams(window.location.search).get("to") ?? "planner")
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("view")
    if (requested === "plans" || requested === "roster" || requested === "console") {
      setView(requested)
    }
  }, [setView])

  // First-ever open: baseline the "seen" cursors to current activity so the
  // roster isn't a wall of "new" dots — after this, a dot means traffic that
  // arrived since you started watching. A returning session keeps its history.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || mesh.activity == null || mesh.agents.length === 0) {
      return
    }
    seeded.current = true
    if (Object.keys(getSeen()).length > 0) {
      return
    }
    for (const a of mesh.agents) {
      markSeen(a.id, lastActivityFor(a, mesh.activity))
    }
    markSeen("broadcast", mesh.activity.broadcast)
  }, [mesh.activity, mesh.agents])

  const facets = useMemo(() => deriveFacets(mesh.agents), [mesh.agents])
  const filtered = useMemo(() => filterAgents(mesh.agents, filters), [mesh.agents, filters])
  const online = useMemo(() => mesh.agents.filter((a) => a.status === "online").length, [mesh.agents])
  const selectedAgent = mesh.agents.find((a) => a.id === selectedId)
  const broadcastNew = mesh.activity != null && streamIdGt(mesh.activity.broadcast, getSeen().broadcast ?? "0")

  // Drag the sidebar's right edge to resize (persisted). clientX is the width
  // since the sidebar is flush against the left of the viewport.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const onMove = (ev: PointerEvent) => setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX)))
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
    }
    document.body.style.userSelect = "none"
    document.body.style.cursor = "col-resize"
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const openCompose = (to: string | null) => {
    setComposeTo(to)
    setComposeOpen(true)
  }

  const unregister = (id: string) => {
    if (!window.confirm(`Unregister "${id}"? This deletes its inbox and frees the id. Only do this for true one-offs.`)) {
      return
    }
    api.unregister(id)
      .then(() => {
        if (selectedId === id) {
          setSelectedId(null)
        }
        mesh.refresh()
      })
      .catch((e: Error) => {
        // a confirmed destructive action must never fail silently (daemon down,
        // socket error) — tell the operator the agent is still registered.
        window.alert(`Unregister failed: ${e.message}`)
      })
  }

  return (
    <>
      <div className="relative z-10 flex h-full flex-col">
        <Topbar health={mesh.health} connected={mesh.connected} online={online} total={mesh.agents.length} onCompose={() => openCompose(null)} view={view} setView={setView} />

        {view === "console" ? (
          <main className="min-h-0 flex-1 animate-in-soft">
            <DesktopConsole />
          </main>
        ) : view === "plans" ? (
          <main className="min-h-0 flex-1 animate-in-soft">
            <PlansView initialPlan={planParam} target={toParam} />
          </main>
        ) : (
          <div className="flex min-h-0 flex-1">
            <aside style={{ width: sidebarWidth }} className="flex shrink-0 flex-col bg-card/20">
              <FilterPanel
                filters={filters}
                setFilters={setFilters}
                facets={facets}
                groupBy={groupBy}
                setGroupBy={setGroupBy}
                shown={filtered.length}
                total={mesh.agents.length}
              />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="p-1">
                  <ChannelsRow selectedId={selectedId} onSelect={setSelectedId} isNew={broadcastNew} />
                </div>
                <Separator className="opacity-60" />
                <Roster
                  agents={filtered}
                  groupBy={groupBy}
                  scopes={facets.scopes}
                  local={mesh.local}
                  activity={mesh.activity}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              </div>
            </aside>

            {/* resize handle */}
            <div onPointerDown={startResize} className="group relative z-20 -ml-px w-1.5 shrink-0 cursor-col-resize" title="Drag to resize">
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/70 transition-colors group-hover:w-0.5 group-hover:bg-primary/70" />
            </div>

            <main className="min-w-0 flex-1 animate-in-soft">
              <DetailPane id={selectedId} agent={selectedAgent} onComposeTo={openCompose} onUnregister={unregister} />
            </main>
          </div>
        )}
      </div>

      <Composer open={composeOpen} onOpenChange={setComposeOpen} initialTo={composeTo} agents={mesh.agents} onSent={mesh.refresh} />
    </>
  )
}
