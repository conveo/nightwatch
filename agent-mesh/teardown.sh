#!/usr/bin/env bash
# Clean up after an overnight run, on the host you ran it on.
#
# It does the ONE destructive thing that's safe to automate — retire the
# managed mesh ids you name (reviewers, throwaway workers) — and otherwise just
# REPORTS suspected orphans with copy-paste commands. It deliberately does NOT
# auto-kill processes: on a shared host the live orchestrator / your own session
# look identical to a dead worker, and a blanket `kill claude` would take down
# the wrong one.
#
#   ./agent-mesh/teardown.sh <one-off-id> [<one-off-id> ...]
#
# What it never touches: long-lived mesh ids you didn't name (a `stale` id is
# fine to leave), and Superset workspaces/terminals — delete those via the
# orchestrator's Superset CLI with explicit --host; this script only retires mesh bindings.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"

ids=("$@")

echo "agent-mesh teardown on $(hostname)"
echo

# Retire only explicitly named managed actors; never consume or erase inboxes.
for id in "${ids[@]}"; do
  generation="$(agent-mesh delivery --id "$id" | jq -r '.transport.generation // empty')"
  if [[ -z "$generation" ]]; then
    echo "  $id: legacy/unbound; inspect unread mail and clean up deliberately. No changes made."
  elif agent-mesh retire --id "$id" --generation "$generation"; then
    echo "  $id: retired, inbox preserved"
  else
    echo "  $id: retirement failed; inspect binding/in-flight delivery before retrying" >&2
  fi
done

# 2. Report suspected orphan dev servers (don't kill — see header). Excludes the
#    mesh daemon + watchers, which are infrastructure you must NOT kill.
echo
echo "suspected orphan dev servers (review, then kill the dead ones by PID):"
ps_out="$(pgrep -fl 'pnpm dev|vite' 2>/dev/null | grep -vE 'daemon\.ts|cli\.ts watch|teardown\.sh' || true)"
if [[ -z "$ps_out" ]]; then echo "  none"; else echo "$ps_out" | sed 's/^/  /'; fi

# 3. Report per-worktree docker containers (per-worktree redis/postgres).
echo
echo "per-worktree docker containers (stop the finished ones explicitly):"
dk="$(docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null | grep -E "${AGENT_MESH_TEARDOWN_CONTAINERS:-agent-mesh-test}" || true)"
if [[ -z "$dk" ]]; then echo "  none"; else echo "$dk" | sed 's/^/  /'; fi

echo
echo "next: delete the run's Superset workspaces/terminals via the orchestrator"
echo "      (Superset CLI with explicit host/workspace IDs), after checking the run manifest."
