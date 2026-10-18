#!/usr/bin/env bash
# Shared bootstrap helpers for the agent-mesh entrypoints
# (start-local.sh, a reviewer launcher, lib/install-supervisor.sh). SOURCE this
# file; do not execute it.

# Absolute, so a caller that sources this by a relative path and then cd's
# still finds the site hook.
_MESH_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null && pwd)"

# Resolve + export AGENT_MESH_REDIS_URL. The environment wins: when it is set,
# nothing else runs. Otherwise an optional site hook is sourced and asked for a
# URL: the file named by AGENT_MESH_SITE_HOOK, when it
# exists. A hook defines `mesh_site_resolve_redis_url`, which prints the URL.
# Returns 1, with a hint, when neither yields one.
resolve_mesh_url() {
  if [[ -n "${AGENT_MESH_REDIS_URL:-}" ]]; then
    return 0
  fi
  local hook="${AGENT_MESH_SITE_HOOK:-}" url=""
  if [[ -f "$hook" ]]; then
    # shellcheck source=/dev/null
    . "$hook"
    if declare -F mesh_site_resolve_redis_url >/dev/null; then
      url="$(mesh_site_resolve_redis_url)"
    fi
  fi
  if [[ -z "$url" ]]; then
    echo "agent-mesh: AGENT_MESH_REDIS_URL is not set and no site hook supplied one; export it (e.g. redis://localhost:6379) or set AGENT_MESH_SITE_HOOK" >&2
    return 1
  fi
  export AGENT_MESH_REDIS_URL="$url"
}

# Install the identity-agnostic `agent-mesh` CLI wrapper on PATH. Arg $1 = repo root.
# Idempotent. The wrapper honors an explicit identity — an AGENT_MESH_ID whose
# setter declared intent, or either runtime's own native session derivation — and
# only falls back to the persisted cli.env default for a plain human terminal that
# has neither. So a single-purpose spawn (e.g. a reviewer launcher) can run it without
# hijacking another session's identity, and it matches the `agent-mesh` skill's
# bootstrap wrapper (cwd-stable via AGENT_MESH_CALLER_CWD).
#
# The shared wrapper lives at one path on PATH, but every worktree bootstrap calls
# this helper. A worktree therefore never displaces a working non-worktree target:
# repointing at a worktree strands every other session on the host the moment that
# worktree is deleted or its deps are pruned.
# True when $1 is a git worktree linked to another checkout. Ask git rather than
# matching path shapes: worktrees come from Superset (.superset/worktrees/) and
# from `git worktree add` (often a sibling of the repo), and a pattern only ever
# covers the layouts it happens to list. A linked worktree's git dir always
# resolves under <main>/.git/worktrees/<name>. The path check is the fallback for
# a directory git cannot resolve at all.
_mesh_is_linked_worktree() {
  local dir="$1" gitdir
  gitdir="$(git -C "$dir" rev-parse --absolute-git-dir 2>/dev/null || true)"
  if [ -n "$gitdir" ]; then
    [[ "$gitdir" == */.git/worktrees/* ]]
    return
  fi
  [[ "$dir" == */.superset/worktrees/* ]]
}

install_cli_wrapper() {
  local repo="$1" wrapper="$HOME/.local/bin/agent-mesh" current="" node_bin
  if [ -f "$wrapper" ]; then
    current="$(sed -n 's/.*pnpm --dir "\(.*\)\/agent-mesh".*/\1/p' "$wrapper" | head -1)"
  fi
  if [[ -n "$current" && -d "$current/agent-mesh" ]] \
     && _mesh_is_linked_worktree "$repo" \
     && ! _mesh_is_linked_worktree "$current"; then
    echo "agent-mesh: keeping the shared wrapper on $current (not repointing it at a worktree)" >&2
    return 0
  fi
  # On a bare checkout (no root install), make the package's own deps exist (fast, 4 pkgs).
  [ -d "$repo/agent-mesh/node_modules" ] || [ -x "$repo/node_modules/.bin/tsx" ] || pnpm --dir "$repo/agent-mesh" install
  node_bin="$(command -v node 2>/dev/null || true)"
  mkdir -p "$HOME/.local/bin"
  # The wrapper runs the CLI with node + the checkout's own tsx and only falls
  # back to pnpm when the checkout has no tsx. pnpm puts its version manager in
  # front of every call: a packageManager pin the host cannot honour yet (a newer
  # pnpm whose native binary never got installed, corepack refusing in a bare
  # env) takes down every agent's CLI on the host at once, and pnpm 12 runs a
  # full workspace install before `exec`. The pnpm line also stays because
  # install_cli_wrapper and supervisor.sh read the wrapper's target from it.
  cat >"$wrapper" <<WRAPPER
#!/usr/bin/env bash
mesh_native_flag=""
for mesh_arg in "\$@"; do
  if [ "\$mesh_arg" = "--native-session" ]; then mesh_native_flag=1; fi
done
mesh_runtime=""
if [ -n "\${CLAUDE_CODE_SESSION_ID:-}" ] || [ -n "\${CODEX_THREAD_ID:-}" ] || [ -n "\${AGENT_MESH_NATIVE_SESSION:-}" ] || [ -n "\${SUPERSET_TERMINAL_ID:-}" ] || [ -n "\${HERDR_PANE_ID:-}" ]; then
  mesh_runtime=1
fi
# A runtime session derives its own identity, so an AGENT_MESH_ID visible here is
# only trustworthy when its setter declared intent. Agent terminals INHERIT the
# launching session's exported id (a Superset host spawns them from the laptop
# orchestrator's environment), and an inherited id otherwise wins silently: the CLI
# publishes as the launcher, so peers reply to the launcher's inbox and the real
# sender goes deaf. Deliberate setters export AGENT_MESH_ID_EXPLICIT=1 alongside.
if [ -n "\$mesh_runtime" ] && [ -n "\${AGENT_MESH_ID:-}" ] && [ -z "\${AGENT_MESH_ID_EXPLICIT:-}" ]; then
  echo "agent-mesh: ignoring inherited AGENT_MESH_ID=\$AGENT_MESH_ID in a runtime session (deriving natively; pass --id, or export AGENT_MESH_ID_EXPLICIT=1 if it is deliberate)" >&2
  unset AGENT_MESH_ID
fi
if [ -z "\$mesh_native_flag" ] && [ -z "\${AGENT_MESH_ID:-}" ] && [ -z "\$mesh_runtime" ] && [ -f "\$HOME/.agent-mesh/cli.env" ]; then
  set -a; . "\$HOME/.agent-mesh/cli.env"; set +a
fi
export AGENT_MESH_CALLER_CWD="\$PWD"
# Root tsx first (the one the daemon runs on), then the package-local one a bare
# checkout gets from the install above.
mesh_tsx="$repo/node_modules/tsx/dist/cli.mjs"
[ -f "\$mesh_tsx" ] || mesh_tsx="$repo/agent-mesh/node_modules/tsx/dist/cli.mjs"
mesh_node="$node_bin"; [ -x "\$mesh_node" ] || mesh_node="\$(command -v node 2>/dev/null)"
if [ -f "\$mesh_tsx" ] && [ -x "\$mesh_node" ]; then
  cd "$repo/agent-mesh" && exec "\$mesh_node" "\$mesh_tsx" src/cli.ts "\$@"
fi
exec pnpm --dir "$repo/agent-mesh" exec tsx src/cli.ts "\$@"
WRAPPER
  chmod +x "$wrapper"
}

# Persist AGENT_MESH_ID as this machine's DEFAULT CLI identity (picked up by a
# plain terminal that sets neither AGENT_MESH_ID nor a Claude session id). Call
# this ONLY from the entrypoint that owns the laptop's default identity
# (start-local.sh) — a single-purpose spawn must NOT clobber the shared file.
persist_cli_identity() {
  mkdir -p "$HOME/.agent-mesh"
  printf 'AGENT_MESH_ID=%s\n' "$AGENT_MESH_ID" >"$HOME/.agent-mesh/cli.env"
}

# Register only a new actor. Existing mode is intentionally never auto-converted.
# Monitor capability is supplied by the harness, never inferred from runtime.
register_mesh_actor() {
  local role="$1" existing
  existing="$(agent-mesh delivery | jq -r '.transport // empty')"
  if [[ -z "$existing" ]]; then
    local args=(register --role "$role" --deliver auto)
    [[ "${AGENT_MESH_MONITOR:-0}" == "1" ]] && args+=(--monitor)
    [[ "${AGENT_MESH_DEDICATED:-0}" == "1" ]] && args+=(--dedicated)
    [[ -n "${AGENT_MESH_BINDING:-}" ]] && args+=(--binding "$AGENT_MESH_BINDING")
    [[ -n "${AGENT_MESH_RUNTIME:-}" ]] && args+=(--runtime "$AGENT_MESH_RUNTIME")
    agent-mesh "${args[@]}"
  fi
  agent-mesh delivery
}
