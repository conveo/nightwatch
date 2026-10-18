// The conversation list, in two parts.
//
// TOP: threads that exist — every agent that has written to the operator, newest first,
// plus anyone they have written to from this phone. The server can only derive the
// first half: a mesh message lands in the RECIPIENT's stream, so an agent they have
// only ever sent to leaves no trace in their own inbox. The ids they have sent to are
// remembered locally and merged in, which is what stops a thread from vanishing the
// moment it is started.
//
// BELOW: the rest of the roster. Without it the screen is empty on a quiet day even
// though many agents are registered, and there would be no way to start a thread
// with one from the phone at all — the console can only reach an agent they can name.

import { Radio, Search, Server, User } from "lucide-react"
import { useMemo, useState } from "react"
import type { AgentRecord } from "@/lib/api"
import { relTime, TYPE_STYLE } from "@/lib/format"
import { StatusDot } from "@/components/ui/core"
import { cn } from "@/lib/utils"
import type { ConversationSummary } from "./console-api"
import { splitAgentId } from "./console-api"

type Props = {
  peers: ConversationSummary[]
  agents: AgentRecord[]
  hostname: string
  sentTo: string[]
  onOpen: (peer: string) => void
}

type Row = {
  id: string
  preview: string | null
  ts: string | null
  type: ConversationSummary["lastType"] | null
  unread: number
  agent: AgentRecord | undefined
}

// The roster can run to hundreds across everyone's machines. Showing all of it unfiltered
// is a wall; this host's live agents are the ones the operator actually reaches for, and the
// filter box opens up the rest.
const ROSTER_PREVIEW = 25

export function Threads({ peers, agents, hostname, sentTo, onOpen }: Props) {
  const [q, setQ] = useState("")
  const query = q.trim().toLowerCase()
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  const threads = useMemo<Row[]>(() => {
    const seen = new Set(peers.map((p) => p.id))
    const fromInbox: Row[] = peers.map((p) => ({ id: p.id, preview: p.preview, ts: p.lastTs, type: p.lastType, unread: p.unreadFrom, agent: byId.get(p.id) }))
    const sendOnly: Row[] = sentTo
      .filter((id) => !seen.has(id))
      .map((id) => ({ id, preview: null, ts: null, type: null, unread: 0, agent: byId.get(id) }))
    return [...fromInbox, ...sendOnly]
  }, [peers, sentTo, byId])

  const rest = useMemo<Row[]>(() => {
    const taken = new Set(threads.map((r) => r.id))
    return agents
      .filter((a) => !taken.has(a.id))
      .sort((a, b) => {
        // Local + online first, then most recently seen: the ordering that puts the
        // agent the operator is thinking about at the top without them typing anything.
        const score = (x: AgentRecord) => (x.host === hostname ? 2 : 0) + (x.status === "online" ? 1 : 0)
        return score(b) - score(a) || b.lastSeen.localeCompare(a.lastSeen)
      })
      .map((a) => ({ id: a.id, preview: a.role, ts: a.lastSeen, type: null, unread: 0, agent: a }))
  }, [agents, threads, hostname])

  const matches = (r: Row) => query === "" || r.id.toLowerCase().includes(query) || (r.agent?.role ?? "").toLowerCase().includes(query)
  const shownThreads = threads.filter(matches)
  const shownRest = rest.filter(matches).slice(0, query === "" ? ROSTER_PREVIEW : 60)

  return (
    <div className="mesh-scroll min-h-0 flex-1 overflow-y-auto">
      <div className="sticky top-0 z-10 border-b border-border/60 bg-background/90 px-3 py-2.5 backdrop-blur-xl">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card/60 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            className="h-10 w-full bg-transparent font-mono text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground/70"
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Filter ${agents.length} agents…`}
            value={q}
          />
        </div>
      </div>

      {query === "" && (
        <button className="flex w-full items-center gap-3 border-b border-border/50 px-3 py-3.5 text-left active:bg-accent/50" onClick={() => onOpen("broadcast")} type="button">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
            <Radio className="size-4.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium">broadcast</span>
            <span className="block truncate text-[13px] text-muted-foreground">Everything on the mesh-wide channel</span>
          </span>
        </button>
      )}

      {shownThreads.length > 0 && (
        <>
          <SectionLabel>Conversations</SectionLabel>
          <RowList onOpen={onOpen} rows={shownThreads} />
        </>
      )}

      {shownRest.length > 0 && (
        <>
          <SectionLabel>{query === "" ? `Agents on ${hostname}` : `${shownRest.length} matching agents`}</SectionLabel>
          <RowList onOpen={onOpen} rows={shownRest} />
        </>
      )}

      {shownThreads.length === 0 && shownRest.length === 0 && (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">Nothing matching “{q}”.</p>
      )}
      <div className="mesh-safe-bottom h-2" />
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="bg-muted/40 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</p>
}

function RowList({ rows, onOpen }: { rows: Row[]; onOpen: (peer: string) => void }) {
  return (
    <ul>
      {rows.map((row) => {
        const { scope, leaf } = splitAgentId(row.id)
        const isHost = row.id.startsWith("host:")
        return (
          <li key={row.id}>
            <button className="flex w-full items-center gap-3 border-b border-border/50 px-3 py-3 text-left active:bg-accent/50" onClick={() => onOpen(row.id)} type="button">
              <span className="relative grid size-10 shrink-0 place-items-center rounded-full border border-border/70 bg-card/60 text-muted-foreground">
                {isHost ? <Server className="size-4.5" /> : <User className="size-4.5" />}
                {row.agent != null && (
                  <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-background p-0.5">
                    <StatusDot status={row.agent.status} />
                  </span>
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[14px] font-medium">
                    {scope != null && <span className="text-muted-foreground/70">{scope}.</span>}
                    {leaf}
                  </span>
                  {row.ts != null && <span className="shrink-0 text-[11px] tabular text-muted-foreground">{relTime(row.ts)}</span>}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5">
                  {row.type != null && (
                    <span className="shrink-0 text-[10.5px] font-medium uppercase tracking-wide" style={{ color: TYPE_STYLE[row.type].color }}>
                      {row.type}
                    </span>
                  )}
                  <span className={cn("min-w-0 flex-1 truncate text-[13px]", row.preview != null ? "text-muted-foreground" : "text-muted-foreground/60 italic")}>
                    {row.preview ?? "no messages yet"}
                  </span>
                  {row.unread > 0 && <span className="shrink-0 rounded-full bg-primary px-1.5 py-px text-[10.5px] font-semibold text-primary-foreground tabular">{row.unread}</span>}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
