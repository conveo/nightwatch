// Typed client for the mobile console's /api/console/* routes.

import type { MeshMessage } from "@/lib/api"

export type ConsoleConfig = {
  operatorId: string
  hostname: string
  chat: { available: boolean; model: string }
  voice: { available: boolean; model: string; transcribeModel: string; voice: string }
}

export type ConversationSummary = {
  id: string
  lastId: string
  lastTs: string
  lastFrom: string
  lastType: MeshMessage["type"]
  preview: string
  unreadFrom: number
}

export type ThreadResult = { peer: string; me: string; messages: MeshMessage[]; sendOnly: boolean }

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) {
    throw new Error(`${path} → ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<T>
}

export const consoleApi = {
  config: () => getJson<ConsoleConfig>("/api/console/config"),
  conversations: (me: string) => getJson<{ me: string; peers: ConversationSummary[]; readCount: number | null }>(`/api/console/conversations?me=${encodeURIComponent(me)}`),
  thread: (args: { peer: string; me: string }) =>
    getJson<ThreadResult>(`/api/console/thread?peer=${encodeURIComponent(args.peer)}&me=${encodeURIComponent(args.me)}`),
  // The voice session runs its tool loop in the browser; the implementations live
  // on the server, so each call comes back through here.
  runTool: async (name: string, input: unknown): Promise<unknown> => {
    const res = await fetch("/api/console/mesh-tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, input }),
    })
    if (!res.ok) {
      return { error: `tool '${name}' failed (${res.status})` }
    }
    const parsed = (await res.json()) as { output?: unknown }
    return parsed.output ?? {}
  },
}

/** Publish a mesh message as the operator. Used by the direct-thread composer. */
export async function sendMeshMessage(args: {
  me: string
  to: string
  type: MeshMessage["type"]
  text: string
  correlationId: string | null
}): Promise<{ id: string; to: string }> {
  const res = await fetch("/api/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: args.me,
      to: args.to,
      type: args.type,
      body: { text: args.text, via: "mobile-console" },
      correlationId: args.correlationId,
      replyTo: null,
    }),
  })
  if (!res.ok) {
    throw new Error(`publish → ${res.status}: ${await res.text()}`)
  }
  const parsed = (await res.json()) as { id?: string; to?: string; error?: unknown }
  if (parsed.id == null) {
    throw new Error(`publish rejected: ${JSON.stringify(parsed.error ?? parsed)}`)
  }
  return { id: parsed.id, to: parsed.to ?? args.to }
}

// ── id presentation ───────────────────────────────────────────────────────────
// Agent ids are long and dotted (`acme.box.run1.orchestrator`,
// `worktree-a1b2.laptop.c3d4e5f6`). On a 390px screen the leaf is the part that
// identifies the agent, so it gets the weight and the scope is shown quieter.

export function splitAgentId(id: string): { scope: string | null; leaf: string } {
  const parts = id.split(".")
  if (parts.length === 1) {
    return { scope: null, leaf: id }
  }
  return { scope: parts.slice(0, -1).join("."), leaf: parts[parts.length - 1] }
}

/** Prefer the prose an agent actually wrote; mirrors the server's bodyToText. */
const PROSE_KEYS = ["text", "msg", "message", "summary", "what", "question", "comment", "note", "status", "result"]

export function bodyToText(body: Record<string, unknown>): string {
  for (const key of PROSE_KEYS) {
    const v = body[key]
    if (typeof v === "string" && v.trim() !== "") {
      return v.trim()
    }
  }
  const parts: string[] = []
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined) {
      continue
    }
    parts.push(`**${k}** — ${typeof v === "object" ? `\`${JSON.stringify(v)}\`` : String(v)}`)
  }
  return parts.join("\n\n")
}
