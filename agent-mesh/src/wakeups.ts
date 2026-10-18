import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { atomicJson } from "./persistence.js"
import { ensureHome, meshHome, readInboxLines, getAgentState } from "./local-store.js"
import type { MeshMessage } from "./types.js"

export type Batch = {
  token: string
  through: number
  tick: number | null
  created: number
  outcome: "pending" | "sending" | "submitted" | "ambiguous" | "exhausted"
  attempts: number
  nextAttempt: number
  reason: string | null
}
type State = {
  generation: string
  receivedThrough: number
  lastTickReceipt: number | null
  lastReceipt: { token: string; at: number; tick: number | null } | null
  batch: Batch | null
  nextTick: number | null
  dueTick: number | null
}
type File = Record<string, State>

// One daemon owns these synchronous read/modify/atomic-rename transactions.
// A sending record restored after a crash is ambiguous, never blindly replayed.
export class Wakeups {
  private path() {
    return join(meshHome(), "wakeups.json")
  }
  private read(): File {
    return existsSync(this.path()) ? JSON.parse(readFileSync(this.path(), "utf8")) : {}
  }
  private write(value: File) {
    ensureHome()
    atomicJson(this.path(), value)
  }
  state(id: string): State | null {
    return this.read()[id] ?? null
  }

  bind({ id, generation, now, tickMs }: { id: string; generation: string; now: number; tickMs: number | null }): void {
    const all = this.read()
    const previous = all[id]
    all[id] = {
      generation,
      receivedThrough: previous?.receivedThrough ?? getAgentState(id).readCount,
      lastReceipt: null,
      lastTickReceipt: null,
      batch: null,
      nextTick: tickMs == null ? null : now + tickMs,
      dueTick: null,
    }
    this.write(all)
  }

  tick({ id, generation, now, tickMs }: { id: string; generation: string; now: number; tickMs: number }): void {
    const all = this.read()
    const state = all[id]
    if (state == null || state.generation !== generation || state.nextTick == null || now < state.nextTick) return
    // Only one overdue tick is retained, including during an unreceipted batch.
    if (state.dueTick == null) state.dueTick = state.nextTick
    state.nextTick = now + tickMs
    this.write(all)
  }

  claim({ id, generation, now }: { id: string; generation: string; now: number }): (Batch & { messages: MeshMessage[] }) | null {
    const all = this.read()
    const state = all[id] ?? {
      generation,
      receivedThrough: getAgentState(id).readCount,
      lastReceipt: null,
      lastTickReceipt: null,
      batch: null,
      nextTick: null,
      dueTick: null,
    }
    if (state.generation !== generation) throw new Error("stale binding generation")
    const messages = readInboxLines(id)
    if (state.batch == null) {
      const through = Math.min(messages.length, state.receivedThrough + 100)
      if (through === state.receivedThrough && state.dueTick == null) return null
      state.batch = {
        token: randomUUID(),
        through,
        tick: state.dueTick,
        created: now,
        outcome: "pending",
        attempts: 0,
        nextAttempt: now + 250,
        reason: null,
      }
      all[id] = state
      this.write(all)
    }
    return { ...state.batch, messages: messages.slice(state.receivedThrough, state.batch.through) }
  }

  update({
    id,
    generation,
    token,
    patch,
  }: {
    id: string
    generation: string
    token: string
    patch: Partial<Pick<Batch, "outcome" | "attempts" | "nextAttempt" | "reason">>
  }): boolean {
    const all = this.read()
    const state = all[id]
    if (state?.generation !== generation || state.batch?.token !== token) return false
    Object.assign(state.batch, patch)
    this.write(all)
    return true
  }

  ack({ id, generation, token, now }: { id: string; generation: string; token: string; now: number }): void {
    const all = this.read()
    const state = all[id]
    if (state?.generation !== generation) throw new Error("stale binding generation")
    if (state.lastReceipt?.token === token) return
    if (state.batch?.token !== token) throw new Error("stale batch token")
    state.receivedThrough = state.batch.through
    state.lastReceipt = { token, at: now, tick: state.batch.tick }
    if (state.batch.tick != null) state.lastTickReceipt = now
    if (state.dueTick === state.batch.tick) state.dueTick = null
    state.batch = null
    this.write(all)
  }

  restore(id: string): void {
    const all = this.read()
    const batch = all[id]?.batch
    if (batch?.outcome !== "sending") return
    batch.outcome = "ambiguous"
    batch.reason = "daemon-exited-during-submission"
    this.write(all)
  }

  retire(id: string): void {
    const all = this.read()
    const state = all[id]
    if (state == null) return
    state.generation = `retired-${randomUUID()}`
    state.batch = null
    state.nextTick = null
    state.dueTick = null
    this.write(all)
  }
}
