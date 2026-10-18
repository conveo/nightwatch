// Typed client for the ui-server's /api/* routes (which bridge to the daemon).

export type AgentStatus = "online" | "dead" | "stale" | "offline"

export type AgentRecord = {
  id: string
  role: string
  host: string | null
  meta: Record<string, unknown>
  status: AgentStatus
  registeredAt: string
  lastSeen: string
}

export type MeshMessage = {
  id: string
  ts: string
  from: string
  to: string
  type: "status" | "blocker" | "decision" | "request" | "result" | "note"
  body: Record<string, unknown>
  correlationId: string | null
  replyTo: string | null
  channel: string
}

export const MESSAGE_TYPES = ["status", "blocker", "decision", "request", "result", "note"] as const

export type Health = { ok: boolean; hostname: string; socket: string; localAgents?: string[] }
export type LocalAgent = { id: string; total: number; unread: number }
export type Activity = {
  agents: Record<string, string>
  broadcast: string
  hosts?: Record<string, string>
}
export type Inspection = {
  id: string
  source: string
  history: MeshMessage[]
  readCount: number | null
}

export type PlanDoc = { path: string; name: string; content: string; format: "markdown" | "html"; root: string }

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) {
    throw new Error(`${path} → ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<T>
}

// Same non-2xx guard as getJson, for the POST routes. Without it, a 5xx with a
// non-JSON or empty body throws a misleading SyntaxError from res.json() instead
// of a real HTTP error — so the guard lives here, at the API layer, not patched
// into each caller. On failure the response text is included for context.
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${path} → ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  health: () => getJson<Health>("/api/health"),
  agents: () => getJson<AgentRecord[]>("/api/agents"),
  local: () => getJson<LocalAgent[]>("/api/local"),
  activity: () => getJson<Activity>("/api/activity"),
  inspect: (id: string) => getJson<Inspection>(`/api/inspect?id=${encodeURIComponent(id)}`),
  publish: (payload: {
    from: string
    to: string
    type: string
    body: Record<string, unknown>
    correlationId: string | null
    replyTo: string | null
  }): Promise<{ id?: string; to?: string; error?: unknown }> =>
    postJson<{ id?: string; to?: string; error?: unknown }>("/api/publish", payload),
  unregister: (id: string): Promise<{ removed?: boolean }> => postJson<{ removed?: boolean }>("/api/unregister", { id }),
  planRead: (path: string) => getJson<PlanDoc>(`/api/plan-read?path=${encodeURIComponent(path)}`),
  planAssetUrl: (planPath: string, rel: string) =>
    `/api/plan-asset?planPath=${encodeURIComponent(planPath)}&rel=${encodeURIComponent(rel)}`,
}

// "acme.box.run1.orchestrator" → scope segments for prefix-based filtering:
// ["acme", "acme.box", "acme.box.run1"]. The last dotted segment is the
// leaf (role-ish), so scopes stop one short of the full id.
export function scopePrefixes(id: string): string[] {
  const parts = id.split(".")
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(0, i).join("."))
  }
  return out
}

export function hostLabel(host: string | null): string {
  if (host == null || host === "") {
    return "unknown host"
  }
  return host.replace(/\.local$/, "")
}
