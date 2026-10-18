import { appendFileSync, closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, statSync, type BigIntStats } from "node:fs"
import { log } from "./log.js"
import { syncParentDirectory } from "./persistence.js"
import type { MeshMessage } from "./types.js"

type Tail = { type: "complete" } | { type: "missing-newline" } | { type: "partial"; offset: number }
type Snapshot = { signature: string | null; messages: MeshMessage[]; identities: Set<string>; tail: Tail }

function signature(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
}

function identity(message: MeshMessage): string {
  return JSON.stringify([message.channel, message.id])
}

// One daemon writes each inbox. File identity/size/timestamps invalidate snapshots
// after external edits or replacement; a new process rebuilds from the JSONL.
export class InboxStore {
  private cache = new Map<string, Snapshot>()

  private load(path: string): Snapshot {
    let stamp: string
    try {
      stamp = signature(statSync(path, { bigint: true }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      this.forget(path)
      return { signature: null, messages: [], identities: new Set(), tail: { type: "complete" } }
    }
    const cached = this.cache.get(path)
    if (cached?.signature === stamp) return cached
    const data = readFileSync(path)
    const offset = data.lastIndexOf(10) + 1
    const messages = data
      .subarray(0, offset)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as MeshMessage)
    let tail: Tail = { type: "complete" }
    if (offset < data.length) {
      try {
        messages.push(JSON.parse(data.subarray(offset).toString("utf8")) as MeshMessage)
        tail = { type: "missing-newline" }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        // A line without its terminator may be an interrupted append. Complete
        // malformed lines above still throw; do not skip them or shift cursors.
        tail = { type: "partial", offset }
        log.warn("incomplete inbox tail awaits broker replay", { bytes: data.length - offset })
      }
    }
    const snapshot = { signature: stamp, messages, identities: new Set(messages.map(identity)), tail }
    this.remember({ path, snapshot })
    return snapshot
  }

  private remember({ path, snapshot }: { path: string; snapshot: Snapshot }): void {
    this.cache.delete(path)
    this.cache.set(path, snapshot)
    // Bound the number of retained actor snapshots. This does not compact or
    // delete mail; evicted snapshots are rebuilt when that inbox is used again.
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!)
  }

  read(path: string): readonly MeshMessage[] {
    return this.load(path).messages
  }

  append({ path, message }: { path: string; message: MeshMessage }): void {
    const snapshot = this.load(path)
    const key = identity(message)
    const duplicate = snapshot.identities.has(key)
    const encoded = `${JSON.stringify(message)}\n`
    const fd = openSync(path, "a", 0o600)
    try {
      switch (snapshot.tail.type) {
        case "partial":
          ftruncateSync(fd, snapshot.tail.offset)
          break
        case "missing-newline":
          appendFileSync(fd, "\n")
          break
        case "complete":
          break
      }
      if (!duplicate) appendFileSync(fd, encoded)
      // A duplicate may be replay after a failed flush. Sync both file and
      // directory again before allowing the durable broker cursor to advance.
      fsyncSync(fd)
      syncParentDirectory(path)
    } catch (error) {
      this.forget(path)
      throw error
    } finally {
      closeSync(fd)
    }
    if (!duplicate) {
      snapshot.messages.push(JSON.parse(encoded) as MeshMessage)
      snapshot.identities.add(key)
    }
    snapshot.tail = { type: "complete" }
    snapshot.signature = signature(statSync(path, { bigint: true }))
    this.remember({ path, snapshot })
  }

  forget(path: string): void {
    this.cache.delete(path)
  }
}
