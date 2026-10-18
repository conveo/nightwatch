// Default agent-id derivation — THE one place the naming rule lives.
//
//   <worktree-basename>.<short-hostname>.<first-8-of-session-id>
//
// - the session suffix makes the id unique per runtime session (two concurrent
//   sessions in the same worktree are different actors with different inboxes),
//   and stable across resumes (`claude --resume` keeps the session id);
// - the worktree/host prefix is purely for humans + orchestrators reading the
//   roster — a bare session id would force a lookup before every publish.
//
// Resolution order used by the CLI: --id flag > AGENT_MESH_ID env > this.
// Returns null when no native session id is present (e.g. a human shell) —
// humans set AGENT_MESH_ID explicitly (start-local.sh does this for laptops).
//
// The worktree segment resolves against AGENT_MESH_CALLER_CWD when set (the
// skill's wrapper passes it), NOT this process's cwd: the CLI usually runs under
// `pnpm --dir agent-mesh exec`, and a watcher/cron invoked from another
// directory would otherwise derive a DIFFERENT id than the session it serves —
// observed live as duplicate roster entries for one agent.

import { execSync } from "node:child_process"
import { basename } from "node:path"
import { hostname } from "node:os"

export function deriveDefaultAgentId(): string | null {
  const session = process.env.AGENT_MESH_NATIVE_SESSION ?? process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CODEX_THREAD_ID
  if (session == null || session.length < 8) {
    return null
  }
  const callerCwd = process.env.AGENT_MESH_CALLER_CWD ?? process.cwd()
  let worktree: string
  try {
    worktree = basename(
      execSync("git rev-parse --show-toplevel", { cwd: callerCwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim(),
    )
  } catch {
    worktree = basename(callerCwd)
  }
  const host = hostname().split(".")[0]
  const raw = `${worktree}.${host}.${session.slice(0, 8)}`
  // conform to the mesh id charset (defense in depth; worktree/host names are
  // usually already clean)
  return raw.replace(/[^A-Za-z0-9._-]/g, "-")
}