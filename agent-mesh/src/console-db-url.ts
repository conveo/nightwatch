// Where the console's SQLite file lives. Shared by the Prisma CLI (prisma.config.ts)
// and the runtime client so a migration and the server can never disagree about which
// file they are talking to.

import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export function consoleDatabaseDir(): string {
  const home = process.env.AGENT_MESH_HOME
  return home != null && home !== "" ? home : join(homedir(), ".agent-mesh")
}

export function consoleDatabaseUrl(): string {
  const override = process.env.CONSOLE_DATABASE_URL
  if (override != null && override !== "") {
    return override
  }
  return `file:${join(consoleDatabaseDir(), "console.db")}`
}

/**
 * Create the database file owner-only (0600) before SQLite opens it. It holds every
 * conversation with the assistant, and the mesh home is shared with every agent
 * process on the host. SQLite gives its -wal and -shm files the same mode.
 */
export function prepareConsoleDatabaseFile(url: string): void {
  if (!url.startsWith("file:")) {
    return
  }
  const path = url.slice("file:".length)
  if (path === "" || path === ":memory:") {
    return
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  closeSync(openSync(path, "a", 0o600))
  chmodSync(path, 0o600)
}
