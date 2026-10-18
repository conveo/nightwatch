// Which chat is open, and what other chats exist.
//
// The id lives in localStorage so returning from a notification lands back in the
// conversation the operator was in, not always in the first one. The LIST comes from the server,
// because that is the copy that survives a cleared browser and a second device.

import { useCallback, useEffect, useState } from "react"

export type ConversationSummary = { id: string; title: string; messages: number; updatedAt: string }

const ACTIVE_KEY = "agent-mesh:console-active-conversation"
export const DEFAULT_CONVERSATION = "default"

function loadActive(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? DEFAULT_CONVERSATION
  } catch {
    return DEFAULT_CONVERSATION
  }
}

export function useConversations(): {
  active: string
  list: ConversationSummary[]
  select: (id: string) => void
  create: () => string
  refresh: () => void
} {
  const [active, setActive] = useState<string>(loadActive)
  const [list, setList] = useState<ConversationSummary[]>([])

  const refresh = useCallback(() => {
    void fetch("/api/console/conversations-list")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { conversations?: ConversationSummary[] } | null) => setList(d?.conversations ?? []))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const select = useCallback((id: string) => {
    setActive(id)
    try {
      localStorage.setItem(ACTIVE_KEY, id)
    } catch {
      /* private mode — the choice just does not survive a reload */
    }
  }, [])

  const create = useCallback(() => {
    // Created client-side and only persisted once it has a message: an id alone is not
    // a conversation, and a "New chat" row that appears in the list before the operator has said
    // anything is clutter they then have to clean up.
    const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    select(id)
    return id
  }, [select])

  return { active, list, select, create, refresh }
}
