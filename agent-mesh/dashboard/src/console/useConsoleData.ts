// The data the console needs at either width: who the operator is on the mesh, the live
// roster, and the conversations they already have. Shared by the phone shell and the
// desktop tab so the two cannot drift on polling, identity, or unread counts.

import { useCallback, useEffect, useState } from "react"
import { api, type AgentRecord } from "@/lib/api"
import { usePersistedState } from "@/lib/usePersistedState"
import { consoleApi, type ConsoleConfig, type ConversationSummary } from "./console-api"

// The roster and the conversation list are cheap reads off a local unix socket. Both
// pause while the tab is hidden so a phone in a pocket — or a monitor the operator walked
// away from — is not polling a dev box all afternoon.
const ROSTER_MS = 5000

export type ConsoleData = {
  config: ConsoleConfig | null
  configError: string | null
  me: string
  agents: AgentRecord[]
  peers: ConversationSummary[]
  unread: number
  online: number
  sentTo: string[]
  rememberSent: (peer: string) => void
  refresh: () => void
}

export function useConsoleData(): ConsoleData {
  const [config, setConfig] = useState<ConsoleConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [peers, setPeers] = useState<ConversationSummary[]>([])
  // Agents the operator has written to from this browser. The server cannot know these: a mesh
  // message lands only in the recipient's stream, so a thread they started but that has
  // never answered leaves no trace in their own inbox.
  // Key name predates the desktop console; kept as-is so an existing phone's list
  // survives rather than being silently reset for a tidier string.
  const [sentTo, setSentTo] = usePersistedState<string[]>("mobile-sent-to", [])

  useEffect(() => {
    consoleApi.config().then(setConfig, (e: Error) => setConfigError(e.message))
  }, [])

  const me = config?.operatorId ?? "operator"

  const refresh = useCallback(() => {
    void api.agents().then(setAgents, () => undefined)
    void consoleApi.conversations(me).then((r) => setPeers(r.peers), () => undefined)
  }, [me])

  useEffect(() => {
    if (config == null) {
      return
    }
    refresh()
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refresh()
      }
    }
    const t = setInterval(onVisible, ROSTER_MS)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [config, refresh])

  const rememberSent = useCallback(
    (peer: string) => setSentTo((prev) => (prev.includes(peer) ? prev : [peer, ...prev].slice(0, 40))),
    [setSentTo],
  )

  return {
    config,
    configError,
    me,
    agents,
    peers,
    unread: peers.reduce((n, p) => n + p.unreadFrom, 0),
    online: agents.filter((a) => a.status === "online").length,
    sentTo,
    rememberSent,
    refresh,
  }
}
