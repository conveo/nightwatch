// Pushing a message into a running Claude Code agent via the `claude` CLI.
//
// FINDINGS (claude CLI 2.1.x behaviour the resume transport relies on):
//   - There is NO supported way to inject a message into a live *interactive*
//     (TUI) session in-place. No IPC, socket, or named-pipe interface exists.
//   - `claude --resume <id> -p "<msg>"` APPENDS a turn to an existing session and
//     runs it as a FRESH process. A session is just a transcript file with NO
//     process lock: resuming a session whose original process is STILL ALIVE
//     forks a SECOND process onto the same transcript (duplicated work, lost
//     permission flags, wrong cwd, inbox-cursor races).
//   - Undocumented alternative: `claude -p --input-format stream-json` reads
//     NDJSON user-messages from stdin for as long as the process lives — only
//     usable if YOU launched the agent that way.
//
// So our model: the durable inbox is the reliable backbone; "direct delivery" is
// a best-effort NUDGE for DORMANT sessions only. Before resuming we probe
// whether any process still owns the session and SKIP if so (live agents poll
// their inbox at turn start). The resume turn is intentionally short — it tells
// the agent it has mail and to run `agent-mesh inbox`, rather than cramming the
// payload through the prompt (the payload already sits durably in the inbox).

import { spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { MeshMessage } from "./types.js"
import { log } from "./log.js"
import { isClaudeCommandLine, processCommandLine } from "./process-utils.js"

export function claudeBin(): string {
  return process.env.AGENT_MESH_CLAUDE_BIN ?? "claude"
}

export function nudgePrompt(message: MeshMessage): string {
  const summary = JSON.stringify(message.body).slice(0, 200)
  return [
    `[agent-mesh] New ${message.type} from ${message.from}`,
    message.correlationId != null ? ` (thread ${message.correlationId})` : "",
    `: ${summary}`,
    `\nRun \`agent-mesh inbox\` to read your full mailbox and act on it.`,
  ].join("")
}

// The resumed turn runs headless (-p): without a permission grant its Bash call
// to read the inbox would stall/deny. Scope the grant to ONLY the agent-mesh CLI
// (both the PATH wrapper and its installed location) — never a blanket bypass.
const NUDGE_ALLOWED_TOOLS = ["Bash(agent-mesh *)", "Bash(~/.local/bin/agent-mesh *)"]

// Exported for testing: the exact argv we'd pass to `claude`.
export function buildResumeArgv(sessionId: string, message: MeshMessage): string[] {
  return ["--resume", sessionId, "-p", nudgePrompt(message), "--allowedTools", ...NUDGE_ALLOWED_TOOLS]
}

// ---- session liveness ----
//
// "Is there a process that currently owns this session?" If yes, resuming would
// FORK it — the cardinal sin this module exists to prevent. Three independent
// signals, cheapest-first; any hit means live. The reason is returned as data so
// the skip log says exactly which signal fired.

export type SessionLiveness = { live: boolean; reason: string }
export type SessionLivenessProbe = (args: { sessionId: string; pid: number | null }) => SessionLiveness

// How recently the session transcript must have been written to count as "some
// process is actively working this session". Conservative on purpose: wrongly
// skipping a resume is cheap (the inbox is durable; agents poll at turn start),
// wrongly forking a live session is the incident we're fixing.
const DEFAULT_TRANSCRIPT_FRESH_MS = 5 * 60_000

function transcriptFreshMs(): number {
  const raw = Number(process.env.AGENT_MESH_SESSION_FRESH_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRANSCRIPT_FRESH_MS
}

// Signal 1: the pid captured at registration (the `claude` process that owned
// the session when the agent registered) is still alive AND still a claude
// process (guards against pid reuse).
function registeredPidOwnsSession(pid: number | null): boolean {
  if (pid == null) {
    return false
  }
  const args = processCommandLine(pid)
  return args != null && isClaudeCommandLine(args)
}

// Signal 2: a live CLAUDE process carries the session id on its argv — covers
// `claude --resume <id>` processes (including ones another daemon spawned, or a
// human resuming the session interactively). pgrep matches the id anywhere in
// any command line, so each candidate pid is re-checked to actually be a claude
// process — an unrelated `tail -f …/<sessionId>.jsonl` must not count as the
// session's owner and indefinitely defer wake-ups.
function someClaudeProcessMentionsSession(sessionId: string): boolean {
  // session ids are uuid-shaped ([0-9a-f-]); guard anyway since the id lands in
  // a pgrep regex.
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    return false
  }
  const res = spawnSync("pgrep", ["-f", sessionId], { encoding: "utf8" })
  if (res.status !== 0) {
    return false
  }
  return res.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .some((pid) => {
      const args = processCommandLine(pid)
      return args != null && isClaudeCommandLine(args)
    })
}

// Signal 3: the session's transcript file was written recently — an actively
// working session appends to ~/.claude/projects/<project>/<sessionId>.jsonl
// continuously, even though a session STARTED fresh never shows its id on argv.
function transcriptRecentlyActive(sessionId: string): { active: boolean; ageMs: number | null } {
  // defense in depth: the id lands in a file path; the transport schema already
  // enforces this charset at the trust boundary
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    return { active: false, ageMs: null }
  }
  const projectsDir = join(homedir(), ".claude", "projects")
  if (!existsSync(projectsDir)) {
    return { active: false, ageMs: null }
  }
  let newestMtime: number | null = null
  for (const project of readdirSync(projectsDir)) {
    const transcript = join(projectsDir, project, `${sessionId}.jsonl`)
    try {
      const mtime = statSync(transcript).mtimeMs
      newestMtime = newestMtime == null ? mtime : Math.max(newestMtime, mtime)
    } catch {
      // no transcript for this session under this project — keep looking
    }
  }
  if (newestMtime == null) {
    return { active: false, ageMs: null }
  }
  const ageMs = Date.now() - newestMtime
  return { active: ageMs < transcriptFreshMs(), ageMs }
}

// The same three signals, but returning the raw evidence behind the verdict.
// The daemon's liveness sweep needs more than a boolean: which pid it checked,
// whether that pid was alive, and how long the transcript has been idle — both to
// decide DEAD safely (never declare death without a basis) and to attach evidence
// to the agent-died event it publishes. defaultSessionLivenessProbe (the delivery
// path) is a thin {live,reason} wrapper over this, so both paths share one
// implementation.
export type LivenessEvidence = {
  live: boolean
  reason: string
  pidChecked: number | null // the pid we existence-checked (null if none was registered)
  pidAlive: boolean // that pid is alive AND still a claude process (pid-reuse guard)
  transcriptAgeMs: number | null // ms since the session transcript last grew (null: no transcript found)
}

export function probeSessionLiveness({ sessionId, pid }: { sessionId: string; pid: number | null }): LivenessEvidence {
  // Cheapest signals first, and the transcript scan (readdirSync + statSync over
  // ~/.claude/projects) stays a last resort — the pid fast-path must not pay for
  // a filesystem walk on every delivery probe. transcriptAgeMs is only consumed
  // on the not-live path (the sweep's `last_transcript_growth` evidence + the
  // no-pid fallback), so it's null when we short-circuit on a live signal.
  if (registeredPidOwnsSession(pid)) {
    return { live: true, reason: `registered claude pid ${pid} is alive`, pidChecked: pid, pidAlive: true, transcriptAgeMs: null }
  }
  if (someClaudeProcessMentionsSession(sessionId)) {
    return { live: true, reason: "a live claude process carries the session id on its argv", pidChecked: pid, pidAlive: false, transcriptAgeMs: null }
  }
  const transcript = transcriptRecentlyActive(sessionId)
  const transcriptAgeMs = transcript.ageMs
  if (transcript.active) {
    return { live: true, reason: `session transcript written ${Math.round(transcriptAgeMs ?? 0)}ms ago`, pidChecked: pid, pidAlive: false, transcriptAgeMs }
  }
  return {
    live: false,
    reason: transcriptAgeMs != null ? `no owning process; transcript idle for ${Math.round(transcriptAgeMs)}ms` : "no owning process; no transcript found",
    pidChecked: pid,
    pidAlive: false,
    transcriptAgeMs,
  }
}

export const defaultSessionLivenessProbe: SessionLivenessProbe = ({ sessionId, pid }) => {
  const ev = probeSessionLiveness({ sessionId, pid })
  return { live: ev.live, reason: ev.reason }
}

// ---- debounced single-flight resume ----

export type NudgeArgs = { sessionId: string; cwd: string | null; pid: number | null; message: MeshMessage }

// The runner spawns the actual resume process. Injectable so tests (and the
// isolated-stack verification) can assert on spawns without a real `claude`.
// MUST call onSettle exactly once when the process ends (or fails to spawn
// asynchronously) — that's what re-arms the per-session single-flight latch.
export type ResumeRunner = (args: { bin: string; argv: string[]; cwd: string; onSettle: () => void }) => { ok: boolean; detail: string }

export const defaultResumeRunner: ResumeRunner = ({ bin, argv, cwd, onSettle }) => {
  try {
    const child = spawn(bin, argv, { cwd, stdio: "ignore", detached: true })
    let settled = false
    const settle = () => {
      if (!settled) {
        settled = true
        onSettle()
      }
    }
    child.on("error", settle) // best-effort; the durable inbox still holds the message
    child.on("exit", settle)
    child.unref() // listeners still fire; just don't keep the daemon's loop alive
    return { ok: true, detail: `spawned ${bin} --resume` }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}

export type ResumeLogger = {
  info: (message: string, ctx?: Record<string, unknown>) => void
  warn: (message: string, ctx?: Record<string, unknown>) => void
}

const DEFAULT_DEBOUNCE_MS = 1_000

function debounceMsFromEnv(): number {
  const raw = Number(process.env.AGENT_MESH_RESUME_DEBOUNCE_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEBOUNCE_MS
}

// Per-session delivery state machine:
//
//   idle ──deliver──▶ debouncing ──timer──▶ fire (probe; skip-or-spawn) ──▶ running ──settle──▶ idle | debouncing
//
// Invariants this enforces (per session):
//   - SINGLE-FLIGHT: at most one resume process at a time.
//   - DEBOUNCE: a burst of N messages collapses into ONE resume — the first
//     message opens a debounce window; everything arriving inside it (or while a
//     resume is running) coalesces into at most one trailing fire. Since the
//     nudge says "drain your inbox", one nudge covers everything.
//   - LIVENESS: the probe runs at FIRE time (not enqueue time) and a live
//     session is never resumed — the message stays in the durable inbox.
//   - CWD: a resume only ever runs in the agent's REGISTERED cwd. No registered
//     cwd → no resume (never the daemon's cwd — that confines the fork to the
//     wrong directory).
type NudgeState = {
  phase: "debouncing" | "running"
  next: NudgeArgs | null
  timer: ReturnType<typeof setTimeout> | null
}

export type ClaudeResumeDeliverer = {
  deliver: (args: NudgeArgs) => { ok: boolean; detail: string }
}

export function createClaudeResumeDeliverer(opts: {
  probe: SessionLivenessProbe
  runner: ResumeRunner
  debounceMs: number | null // null → AGENT_MESH_RESUME_DEBOUNCE_MS (default 1000)
  logger: ResumeLogger
}): ClaudeResumeDeliverer {
  // Intentionally deliverer-lifetime (the daemon holds one deliverer for its
  // whole life — this IS the coalescing state, not request-scoped data). Entries
  // are evicted whenever a session goes idle with nothing pending, so the map
  // only holds sessions with a window open or a resume in flight.
  const states = new Map<string, NudgeState>()

  function schedule(sessionId: string, state: NudgeState): void {
    state.phase = "debouncing"
    const timer = setTimeout(() => fire(sessionId, state), opts.debounceMs ?? debounceMsFromEnv())
    timer.unref?.()
    state.timer = timer
  }

  function goIdle(sessionId: string, state: NudgeState): void {
    if (state.next != null) {
      schedule(sessionId, state)
      return
    }
    states.delete(sessionId)
  }

  function fire(sessionId: string, state: NudgeState): void {
    state.timer = null
    const args = state.next
    state.next = null
    if (args == null) {
      states.delete(sessionId)
      return
    }
    const liveness = opts.probe({ sessionId, pid: args.pid })
    if (liveness.live) {
      // The session has a live owner — resuming would FORK it. Skip: the inbox
      // is durable and live agents poll it at turn start.
      opts.logger.info("resume skipped — session is live", { sessionId, reason: liveness.reason, from: args.message.from, type: args.message.type })
      goIdle(sessionId, state)
      return
    }
    if (args.cwd == null || args.cwd === "") {
      // Never fall back to the daemon's cwd: a resume in the wrong directory is
      // a confined ghost session. Re-register with a cwd to fix.
      opts.logger.warn("resume skipped — no cwd registered for this session (re-register from the agent's worktree)", { sessionId, from: args.message.from })
      goIdle(sessionId, state)
      return
    }
    const res = opts.runner({
      bin: claudeBin(),
      argv: buildResumeArgv(sessionId, args.message),
      cwd: args.cwd,
      onSettle: () => goIdle(sessionId, state),
    })
    if (!res.ok) {
      opts.logger.warn("resume spawn failed", { sessionId, detail: res.detail })
      goIdle(sessionId, state)
      return
    }
    state.phase = "running"
    opts.logger.info("resume fired (session dormant)", { sessionId, cwd: args.cwd, probe: liveness.reason })
  }

  function deliver(args: NudgeArgs): { ok: boolean; detail: string } {
    const existing = states.get(args.sessionId)
    if (existing != null) {
      existing.next = args
      return {
        ok: true,
        detail: existing.phase === "running" ? `coalesced (resume in flight for ${args.sessionId})` : `coalesced (debounce window open for ${args.sessionId})`,
      }
    }
    const state: NudgeState = { phase: "debouncing", next: args, timer: null }
    states.set(args.sessionId, state)
    schedule(args.sessionId, state)
    return { ok: true, detail: `resume scheduled for ${args.sessionId} (debounced; fires only if the session is dormant)` }
  }

  return { deliver }
}

// The daemon's instance: real probe, real spawns, env-tunable debounce.
const defaultDeliverer = createClaudeResumeDeliverer({
  probe: defaultSessionLivenessProbe,
  runner: defaultResumeRunner,
  debounceMs: null,
  logger: log,
})

export function deliverViaClaudeResume(args: NudgeArgs): { ok: boolean; detail: string } {
  return defaultDeliverer.deliver(args)
}

// For agents launched under stream-json input mode, a single NDJSON user-message
// line. Write this to the process's stdin (or a fifo wired to it) to inject a turn.
export function streamJsonUserMessageLine(text: string): string {
  return `${JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text }] })}\n`
}
