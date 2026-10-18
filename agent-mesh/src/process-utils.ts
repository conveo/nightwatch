// Small, dependency-free process inspection helpers shared by the CLI
// (identity capture at registration) and the daemon (session liveness probing).
// Kept separate so importing them never pulls in delivery state (the
// claude-delivery module holds a process-lifetime deliverer singleton).

import { spawnSync } from "node:child_process"
import { readlinkSync } from "node:fs"

// A process's full command line via ps, or null if it's gone.
export function processCommandLine(pid: number): string | null {
  const res = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 })
  if (res.status !== 0) {
    return null
  }
  const line = res.stdout.trim()
  return line === "" ? null : line
}

// True when a ps command line IS a claude process: the executable (first token,
// or the second for "node /path/claude ...") has basename `claude`. A substring
// match would false-positive on e.g. a shell whose argv mentions
// ~/.claude/shell-snapshots/… (observed live on macOS).
export function isClaudeCommandLine(args: string): boolean {
  const tokens = args.trim().split(/\s+/, 2)
  return tokens.some((token) => token.split("/").pop() === "claude")
}

// A process's actual working directory (the OS truth, not what env claims).
// Used at registration to capture the agent's REAL worktree: the CLI itself
// usually runs under `pnpm --dir agent-mesh exec`, which chdirs into the
// package — so process.cwd() lies about where the agent works (forks were
// resumed in the wrong directory for exactly this reason).
export function cwdOfPid(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      return null
    }
  }
  // macOS: no /proc — lsof prints the cwd as an `n…`-prefixed field line
  const res = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 5000 })
  if (res.status !== 0) {
    return null
  }
  const line = res.stdout.split("\n").find((l) => l.startsWith("n"))
  return line != null && line.length > 1 ? line.slice(1) : null
}

// Find the `claude` process that owns THIS CLI invocation by walking up the
// parent chain (claude → shell → pnpm/tsx → this). Captured at registration so
// the daemon's liveness probe can later ask "is the session's process still
// alive?" before resuming the session — resuming a live one forks it.
// Returns null outside a Claude session (e.g. a human shell).
export function findOwningClaudePid(): number | null {
  let pid = process.ppid
  for (let depth = 0; depth < 10 && Number.isInteger(pid) && pid > 1; depth++) {
    const res = spawnSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 })
    if (res.status !== 0) {
      return null
    }
    const match = res.stdout.trim().match(/^(\d+)\s+(.*)$/s)
    if (match == null) {
      return null
    }
    if (isClaudeCommandLine(match[2])) {
      return pid
    }
    pid = Number(match[1])
  }
  return null
}

// Runtime identity and manager transport are independent. Walk ancestry rather
// than searching every process on the host (which can select another agent).
export function findOwningRuntimePid(runtime: "claude" | "codex"): number | null {
  let pid = process.ppid
  for (let depth = 0; depth < 20 && pid > 1; depth++) {
    const result = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 })
    const match = result.status === 0 ? result.stdout.trim().match(/^(\d+)\s+(.*)$/) : null
    if (match == null) return null
    if (match[2].split("/").pop() === runtime) return pid
    pid = Number(match[1])
  }
  return null
}
