import { useCallback, useEffect, useRef, useState } from "react"
import { type Activity, type AgentRecord, api, type Health, type LocalAgent } from "./api"

export type MeshState = {
  health: Health | null
  agents: AgentRecord[]
  local: LocalAgent[]
  activity: Activity | null
  connected: boolean
  error: string | null
}

// Poll the roster + activity on an interval. One source of truth for the app.
export function useMesh(intervalMs = 3000): MeshState & { refresh: () => void } {
  const [state, setState] = useState<MeshState>({
    health: null,
    agents: [],
    local: [],
    activity: null,
    connected: false,
    error: null,
  })
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(() => {
    Promise.all([api.health(), api.agents(), api.local(), api.activity().catch(() => null)])
      .then(([health, agents, local, activity]) => {
        setState({ health, agents, local, activity, connected: health.ok === true, error: null })
      })
      .catch((e: Error) => setState((s) => ({ ...s, connected: false, error: e.message })))
  }, [])

  useEffect(() => {
    refresh()
    timer.current = setInterval(refresh, intervalMs)
    return () => {
      if (timer.current != null) {
        clearInterval(timer.current)
      }
    }
  }, [refresh, intervalMs])

  return { ...state, refresh }
}

// Redis stream ids are "<ms>-<seq>". A lexical compare breaks once seq reaches
// double digits within the same ms ("…-10" < "…-9" as strings), so compare each
// segment numerically. Returns true when a is strictly newer than b.
export function streamIdGt(a: string, b: string): boolean {
  const [ams, aseq] = a.split("-")
  const [bms, bseq] = b.split("-")
  const am = Number(ams)
  const bm = Number(bms)
  if (am !== bm) {
    return am > bm
  }
  return Number(aseq ?? 0) > Number(bseq ?? 0)
}

// Viewer-side "seen" cursors (highest stream id viewed per channel), so the
// roster can flag agents with new traffic. Persisted per-browser.
const SEEN_KEY = "agent-mesh-seen"

export function getSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, string>
  } catch {
    return {}
  }
}

export function markSeen(id: string, streamId: string | null): void {
  if (streamId == null || streamId === "0") {
    return
  }
  const seen = getSeen()
  if (seen[id] == null || streamIdGt(streamId, seen[id])) {
    seen[id] = streamId
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  }
}

// Latest stream id an agent could have "new" traffic on: its inbox, the mesh-wide
// broadcast, or its host's fan-out stream.
export function lastActivityFor(agent: AgentRecord, activity: Activity | null): string {
  if (activity == null) {
    return "0"
  }
  const direct = activity.agents[agent.id] ?? "0"
  const host = agent.host != null && activity.hosts != null ? activity.hosts[agent.host] ?? "0" : "0"
  return [direct, activity.broadcast, host].reduce((m, v) => (streamIdGt(v, m) ? v : m), "0")
}
