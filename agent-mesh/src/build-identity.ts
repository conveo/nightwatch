// Which build is actually serving.
//
// This used to be determined by whether a particular FIELD existed in the
// config response — a proxy that stops working the moment the other build gains that
// field, at which point a wrong-build alarm silently passes and a supervisor seizure
// looks healthy. A commit sha makes the check exact.
//
// Read once at boot: the running process cannot change commit, and shelling out per
// request would be a syscall on a health check.

import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

function readCommit(): { commit: string | null; branch: string | null; dirty: boolean | null } {
  try {
    const run = (args: string[]) => execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", timeout: 3000 }).trim()
    return {
      commit: run(["rev-parse", "HEAD"]),
      branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
      // A dirty tree means the sha does NOT describe what is running, which is exactly
      // when a build-identity check would otherwise mislead.
      dirty: run(["status", "--porcelain"]) !== "",
    }
  } catch {
    return { commit: null, branch: null, dirty: null }
  }
}

const identity = { ...readCommit(), worktree: REPO_ROOT, startedAt: new Date().toISOString(), pid: process.pid }

export function buildIdentity(): typeof identity {
  return identity
}
