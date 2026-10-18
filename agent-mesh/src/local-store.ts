// Host-local persistent state for the daemon. Lives under $AGENT_MESH_HOME
// (default ~/.agent-mesh). Three things are persisted:
//   - inbox/<id>.jsonl    : durable buffer of messages delivered to a local agent.
//   - state.json          : per-agent { deliverCursor, readCount } so the daemon
//                           resumes Redis delivery after a restart and the agent's
//                           read position survives across CLI invocations.
//   - local-agents.json   : which agents this daemon serves (resume after restart).

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { atomicJson } from "./persistence.js"
import { InboxStore } from "./inbox-store.js"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { agentIdSchema, type MeshMessage } from "./types.js"

export function meshHome(): string {
  return process.env.AGENT_MESH_HOME ?? join(homedir(), ".agent-mesh")
}

export function socketPath(): string {
  return process.env.AGENT_MESH_SOCK ?? join(meshHome(), "daemon.sock")
}

function inboxDir(): string {
  return join(meshHome(), "inbox")
}

// The inbox file name is built from the agent id, so the id is checked here and
// not only at the daemon API: ids also arrive from local-agents.json on restart,
// and every read, append and delete of an inbox goes through this one function.
// agentIdSchema has no `/`, so `<id>.jsonl` is always a single name inside the
// inbox directory; the dirname check keeps that true if the charset ever widens.
export function inboxFile(id: string): string {
  const parsed = agentIdSchema.safeParse(id)
  if (!parsed.success) {
    throw new Error(`invalid agent id for an inbox path: ${JSON.stringify(id).slice(0, 140)}`)
  }
  const dir = inboxDir()
  const file = join(dir, `${parsed.data}.jsonl`)
  if (dirname(file) !== dir) {
    throw new Error(`inbox path escapes the inbox directory: ${JSON.stringify(id).slice(0, 140)}`)
  }
  return file
}

function statePath(): string {
  return join(meshHome(), "state.json")
}

export function ensureHome(): void {
  mkdirSync(inboxDir(), { recursive: true })
}

// ---- per-agent state (cursors) ----

type AgentLocalState = {
  deliverCursor: string // last Redis stream id the daemon delivered for this agent ("0" = none)
  readCount: number // how many inbox lines the agent has consumed via GET /inbox
  watchCursor?: number // how many inbox lines `agent-mesh watch` has emitted+acked — SEPARATE from readCount: watching never consumes
}

type StateFile = Record<string, AgentLocalState>

function readState(): StateFile {
  if (!existsSync(statePath())) {
    return {}
  }
  return JSON.parse(readFileSync(statePath(), "utf8")) as StateFile
}

function writeState(state: StateFile): void {
  ensureHome()
  atomicJson(statePath(), state)
}

export function getAgentState(id: string): AgentLocalState {
  return readState()[id] ?? { deliverCursor: "0", readCount: 0 }
}

export function setDeliverCursor(id: string, cursor: string): void {
  const state = readState()
  const cur = state[id] ?? { deliverCursor: "0", readCount: 0 }
  state[id] = { ...cur, deliverCursor: cursor }
  writeState(state)
}

function setReadCount(id: string, readCount: number): void {
  const state = readState()
  const cur = state[id] ?? { deliverCursor: "0", readCount: 0 }
  state[id] = { ...cur, readCount }
  writeState(state)
}

// ---- inbox buffer ----

const inboxes = new InboxStore()

export function appendToInbox(id: string, message: MeshMessage): void {
  ensureHome()
  inboxes.append({ path: inboxFile(id), message })
}

export function readInboxLines(id: string): readonly MeshMessage[] {
  return inboxes.read(inboxFile(id))
}

// Return messages the agent hasn't consumed yet. If peek is false, advance the
// read cursor so the next call returns only newer ones.
export function readUnread(id: string, opts: { peek: boolean }): MeshMessage[] {
  const all = readInboxLines(id)
  const state = getAgentState(id)
  const unread = all.slice(state.readCount)
  if (!opts.peek && unread.length > 0) {
    setReadCount(id, all.length)
  }
  return unread
}

// ---- watch cursor (peek + explicit ack; `agent-mesh watch`) ----
//
// The watcher's contract is AT-LEAST-ONCE: it peeks messages past its own
// cursor, emits each one, and only THEN acks it. A crash between emit and ack
// re-emits that message on restart — a duplicate wake-up is harmless, a
// silently consumed work order cost a night. The cursor is owned by
// the daemon (all mutations go through its socket API), so the state.json
// read-modify-write never races with the daemon's own writes.

// Messages the watcher hasn't acked yet, each tagged with its absolute 1-based
// position in the inbox file (the ack token). A watcher that has never acked
// starts at the agent's read cursor: the unread backlog IS surfaced (those are
// pending work orders), already-consumed history is not.
export function peekWatch(id: string): { cursor: number; messages: Array<{ seq: number; message: MeshMessage }> } {
  const all = readInboxLines(id)
  const state = getAgentState(id)
  const cursor = state.watchCursor ?? state.readCount
  return { cursor, messages: all.slice(cursor).map((message, i) => ({ seq: cursor + i + 1, message })) }
}

// Advance the watch cursor to `upTo` (an absolute count from peekWatch).
// Monotonic — a stale or duplicate ack can never rewind — and clamped to the
// inbox length so a corrupt ack can never skip messages that don't exist yet.
export function ackWatch(id: string, upTo: number): { watchCursor: number } {
  const lineCount = readInboxLines(id).length
  const state = readState()
  const cur = state[id] ?? { deliverCursor: "0", readCount: 0 }
  const effective = cur.watchCursor ?? cur.readCount
  const next = Math.max(effective, Math.min(upTo, lineCount))
  state[id] = { ...cur, watchCursor: next }
  writeState(state)
  return { watchCursor: next }
}

// ---- local agent registry (which agents this daemon serves) ----

export type LocalAgentDef = {
  id: string
  role: string
  meta: Record<string, unknown>
  deliver: unknown // DeliverTransport (validated by the daemon on load)
}

function localAgentsPath(): string {
  return join(meshHome(), "local-agents.json")
}

export function getLocalAgents(): Record<string, LocalAgentDef> {
  if (!existsSync(localAgentsPath())) {
    return {}
  }
  return JSON.parse(readFileSync(localAgentsPath(), "utf8")) as Record<string, LocalAgentDef>
}

// Forget an agent on THIS host: drop it from the served list (so the daemon does
// not re-register it on restart), clear its cursors, and delete its durable
// inbox buffer. Mesh-side removal is hub.unregisterAgent — the daemon's
// /unregister endpoint calls both.
export function removeLocalAgent(id: string): void {
  const all = getLocalAgents()
  if (all[id] != null) {
    delete all[id]
    atomicJson(localAgentsPath(), all)
  }
  const state = readState()
  if (state[id] != null) {
    delete state[id]
    writeState(state)
  }
  rmSync(inboxFile(id), { force: true })
  inboxes.forget(inboxFile(id))
}

export function setLocalAgent(def: LocalAgentDef): void {
  ensureHome()
  const all = getLocalAgents()
  all[def.id] = def
  atomicJson(localAgentsPath(), all)
}

// Retiring delivery preserves history and all consuming cursors.
export function retireLocalAgent(id: string): void {
  inboxes.forget(inboxFile(id))
  const all = getLocalAgents()
  delete all[id]
  atomicJson(localAgentsPath(), all)
}
