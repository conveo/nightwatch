// Delivery transports — how the daemon pushes a message DIRECTLY into a running
// agent process that registered, beyond the durable inbox file + SSE.
//
// At registration an agent declares one of these. The daemon calls deliver() for
// every message addressed to that agent:
//
//   - sse / none   : no push here; delivered via the durable inbox + /subscribe.
//   - claude-resume: resume a DORMANT Claude Code session via `claude --resume`
//                    (debounced; skipped when a process still owns the session —
//                    resuming a live session forks it).
//   - fifo         : write one NDJSON line into a named pipe the process reads
//                    (e.g. an agent launched under `--input-format stream-json`).
//   - file         : append JSONL to a file the process tails.
//   - exec         : spawn a command with the message JSON on argv/stdin.

import { managedTransportSchema } from "./managed-delivery.js"
import { spawn } from "node:child_process"
import { openSync, writeSync, closeSync, appendFileSync, constants as fsConstants } from "node:fs"
import { z } from "zod"
import type { MeshMessage } from "./types.js"
import { deliverViaClaudeResume, streamJsonUserMessageLine } from "./claude-delivery.js"

export const deliverTransportSchema = z.discriminatedUnion("type", [
  managedTransportSchema,
  z.object({ type: z.literal("sse") }),
  z.object({ type: z.literal("none") }),
  // cwd/pid are captured at registration: cwd is where a dormant-session resume
  // runs (no cwd → no resume, never the daemon's cwd); pid is the claude process
  // that owned the session at register time, used by the liveness probe.
  // sessionId charset is enforced at this trust boundary because it flows into
  // a transcript file path and a pgrep pattern in the liveness probe.
  z.object({
    type: z.literal("claude-resume"),
    sessionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/, "session id must match [A-Za-z0-9._-]"),
    cwd: z.string().optional(),
    pid: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("fifo"), path: z.string().min(1), format: z.enum(["json", "stream-json"]).default("json") }),
  z.object({ type: z.literal("file"), path: z.string().min(1) }),
  z.object({ type: z.literal("exec"), cmd: z.array(z.string().min(1)).min(1) }),
])
export type DeliverTransport = z.infer<typeof deliverTransportSchema>

export const DEFAULT_DELIVER: DeliverTransport = { type: "sse" }

// Push a single message into the process via its declared transport.
// Returns a short status for logging; never throws (a broken transport must not
// kill the daemon's delivery loop — the durable inbox still has the message).
export function deliverToProcess(transport: DeliverTransport, message: MeshMessage): { ok: boolean; detail: string } {
  try {
    switch (transport.type) {
      case "managed":
        return { ok: false, detail: "managed delivery requires the durable wakeup scheduler" }
      case "sse":
      case "none":
        return { ok: true, detail: "(via inbox/sse)" }

      case "claude-resume":
        return deliverViaClaudeResume({ sessionId: transport.sessionId, cwd: transport.cwd ?? null, pid: transport.pid ?? null, message })

      case "file":
        appendFileSync(transport.path, `${JSON.stringify(message)}\n`)
        return { ok: true, detail: `file:${transport.path}` }

      case "fifo": {
        const line = transport.format === "stream-json" ? streamJsonUserMessageLine(nudgeText(message)) : `${JSON.stringify(message)}\n`
        // Non-blocking open so we don't hang if no reader is attached; if there's
        // no reader the write is skipped (the durable inbox still holds it).
        let fd: number | null = null
        try {
          fd = openSync(transport.path, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)
          writeSync(fd, line)
          return { ok: true, detail: `fifo:${transport.path}` }
        } catch (e) {
          return { ok: false, detail: `fifo no reader (${(e as { code?: string }).code ?? "ERR"})` }
        } finally {
          if (fd != null) {
            closeSync(fd)
          }
        }
      }

      case "exec": {
        const [cmd, ...rest] = transport.cmd
        const child = spawn(cmd, [...rest, JSON.stringify(message)], { stdio: ["pipe", "ignore", "ignore"], detached: true })
        // A failed spawn (e.g. ENOENT) emits an async 'error' event; with no
        // listener that becomes an uncaught exception that crashes the daemon.
        child.on("error", () => {
          /* best-effort delivery; the durable inbox still holds the message */
        })
        try {
          child.stdin?.write(`${JSON.stringify(message)}\n`)
          child.stdin?.end()
        } catch {
          /* stdin already gone (spawn failed) — handled by the 'error' listener */
        }
        child.unref()
        return { ok: true, detail: `exec:${cmd}` }
      }

      default:
        return { ok: false, detail: "unknown transport" }
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}

function nudgeText(message: MeshMessage): string {
  return `[agent-mesh] new ${message.type} from ${message.from}: ${JSON.stringify(message.body).slice(0, 200)}. Run \`agent-mesh inbox\` to read it.`
}
