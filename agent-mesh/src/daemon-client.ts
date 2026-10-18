// Thin client for the daemon's local Unix-socket HTTP API. Used by the CLI and
// by tests. Agents talk to the daemon through this — never to Redis directly.

import { request } from "node:http"
import { socketPath } from "./local-store.js"
import type { AgentRecord, MeshMessage } from "./types.js"

export async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : undefined
    const req = request(
      {
        socketPath: socketPath(),
        path,
        method,
        headers: payload != null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c as Buffer))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString()
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`daemon ${method} ${path} -> ${res.statusCode}: ${text}`))
            return
          }
          resolve(text === "" ? (undefined as T) : (JSON.parse(text) as T))
        })
      },
    )
    req.setTimeout(15000, () => req.destroy(new Error("daemon request timed out")))
    req.on("error", (e) =>
      reject(new Error(`cannot reach agent-mesh daemon at ${socketPath()} (${(e as Error).message}). Is it running? \`pnpm --dir agent-mesh daemon\``)),
    )
    if (payload != null) {
      req.write(payload)
    }
    req.end()
  })
}

export type DeliverTransportInput =
  | { type: "sse" }
  | { type: "none" }
  | { type: "claude-resume"; sessionId: string; cwd?: string; pid?: number }
  | { type: "fifo"; path: string; format?: "json" | "stream-json" }
  | { type: "file"; path: string }
  | { type: "exec"; cmd: string[] }

export const daemonClient = {
  health: () => call<{ ok: boolean; hostname: string; socket: string; localAgents: string[] }>("GET", "/health"),
  register: (input: { id: string; role: string; meta?: Record<string, unknown>; deliver?: DeliverTransportInput }) =>
    call<{ id: string; role: string; sessionTakeover?: boolean; previousSession?: string | null }>("POST", "/register", input),
  publish: (input: { from: string; to: string; type: string; body: Record<string, unknown>; correlationId?: string | null; replyTo?: string | null }) =>
    call<MeshMessage>("POST", "/publish", input),
  inbox: (id: string, opts: { peek?: boolean } = {}) =>
    call<MeshMessage[]>("GET", `/inbox?id=${encodeURIComponent(id)}${opts.peek === true ? "&peek=1" : ""}`),
  // watch peek/ack — the `agent-mesh watch` loop. Peek never consumes; ack
  // advances the watch cursor (monotonic) to an absolute seq from the peek.
  watchPeek: (id: string) =>
    call<{ cursor: number; generation?: string; messages: Array<{ seq: number; message: MeshMessage }> }>("GET", `/watch?id=${encodeURIComponent(id)}`),
  watchAck: (input: { id: string; upTo: number; generation?: string }) => call<{ id: string; watchCursor: number }>("POST", "/watch/ack", input),
  unregister: (id: string) => call<{ id: string; removed: boolean }>("POST", "/unregister", { id }),
  agents: () => call<AgentRecord[]>("GET", "/agents"),
  lookup: (id: string) => call<AgentRecord | null>("GET", `/lookup?id=${encodeURIComponent(id)}`),
}
