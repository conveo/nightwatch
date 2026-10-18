import { type AgentRecord, type AgentStatus, hostLabel, scopePrefixes } from "./api"

export type GroupBy = "host" | "scope"

export type Filters = {
  query: string
  hosts: string[] // host labels; [] = all
  scope: string | null // an id prefix; null = all
  statuses: AgentStatus[] // [] = all
  roles: string[] // [] = all
}

export const EMPTY_FILTERS: Filters = { query: "", hosts: [], scope: null, statuses: [], roles: [] }

export function activeFilterCount(f: Filters): number {
  return f.hosts.length + (f.scope != null ? 1 : 0) + f.statuses.length + f.roles.length + (f.query.trim() !== "" ? 1 : 0)
}

export function matchesScope(id: string, scope: string): boolean {
  return id === scope || id.startsWith(`${scope}.`)
}

export function filterAgents(agents: AgentRecord[], f: Filters): AgentRecord[] {
  const q = f.query.trim().toLowerCase()
  return agents.filter(
    (a) =>
      (q === "" || a.id.toLowerCase().includes(q) || a.role.toLowerCase().includes(q)) &&
      (f.hosts.length === 0 || f.hosts.includes(hostLabel(a.host))) &&
      (f.scope == null || matchesScope(a.id, f.scope)) &&
      (f.statuses.length === 0 || f.statuses.includes(a.status)) &&
      (f.roles.length === 0 || f.roles.includes(a.role)),
  )
}

export type Facet = { value: string; count: number; online: number }

function tally(agents: AgentRecord[], keyOf: (a: AgentRecord) => string[]): Facet[] {
  const map = new Map<string, Facet>()
  for (const a of agents) {
    for (const value of keyOf(a)) {
      const f = map.get(value) ?? { value, count: 0, online: 0 }
      f.count++
      if (a.status === "online") {
        f.online++
      }
      map.set(value, f)
    }
  }
  return [...map.values()]
}

export function deriveFacets(agents: AgentRecord[]): {
  hosts: Facet[]
  scopes: Facet[]
  roles: Facet[]
} {
  const hosts = tally(agents, (a) => [hostLabel(a.host)]).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  const roles = tally(agents, (a) => [a.role]).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  // Scopes only matter when they span >1 agent (a shared namespace). Deepest-first
  // within equal counts so a specific effort (acme.box.run1) ranks above its
  // parent (acme) at the same coverage.
  const scopes = tally(agents, (a) => scopePrefixes(a.id))
    .filter((s) => s.count >= 2)
    .sort((a, b) => b.count - a.count || b.value.length - a.value.length || a.value.localeCompare(b.value))
  return { hosts, scopes, roles }
}

// Group key for the roster, given the active grouping mode.
export function groupKey(a: AgentRecord, mode: GroupBy, scopes: Facet[]): string {
  if (mode === "host") {
    return hostLabel(a.host)
  }
  // Scope grouping: the most specific shared scope this agent falls under.
  const prefixes = new Set(scopePrefixes(a.id))
  const match = scopes.find((s) => prefixes.has(s.value))
  return match?.value ?? a.id
}
