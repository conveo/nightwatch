#!/bin/bash
# agent-mesh host supervisor — run unattended every few minutes (launchd on macOS via
# lib/install-supervisor.sh; cron on Linux). It is what makes a host's mesh services
# BOTH alive AND current without a human: the host's orchestrator owns it (see
# docs/SUPERVISOR.md). One run does five things and exits:
#  (a) with AGENT_MESH_SUPERVISOR_SYNC=1 only: fast-forwards the base `main` checkout to
#      origin/main (skipped when dirty or not on main). Off by default, because it runs
#      whatever is pushed to main, unattended
#  (b) restarts the mesh daemon ONLY when its health probe fails twice in a row AND the
#      broker host resolves — see the notes at the daemon block
#  (c) keeps the dashboard UI (http://127.0.0.1:4747, src/ui-server.ts) up the same way
#  (d) restarts the daemon + UI when the synced main carries newer agent-mesh/ code than
#      the running daemon was launched from — a healthy daemon is not a current one
#  (e) points the host-wide `agent-mesh` CLI wrapper back at this checkout
#
# Configuration is env-only so the same file serves every host; the installer bakes the
# values into the launchd plist. Defaults assume the repo this script lives in.
#   AGENT_MESH_SUPERVISOR_REPO   repo whose `main` is synced and whose tsx runs the daemon
#   AGENT_MESH_SUPERVISOR_NODE   directory holding the `node` binary (nvm keeps it off PATH)
#   AGENT_MESH_SUPERVISOR_SYNC   1 = fast-forward main to origin/main on every run   (default 0)
#   AGENT_MESH_HOME              daemon socket/pid/logs + daemon.env       (default ~/.agent-mesh)
#   AGENT_MESH_UI_PORT           dashboard port                            (default 4747)
#
# Runs in a bare env: no nvm, no shell rc, no pnpm. Everything is invoked via the repo's
# own tsx under an explicit node — never `pnpm`: outside an interactive shell corepack
# refuses the pinned pnpm version, which makes a HEALTHY daemon look down and the relaunch
# fail. There is deliberately no flock: launchd/cron never overlap one job, and a lock fd
# inherited by the long-lived daemon would make every later run skip.
set -u
REPO="${AGENT_MESH_SUPERVISOR_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_BIN="${AGENT_MESH_SUPERVISOR_NODE:-$(dirname "$(command -v node 2>/dev/null || echo /usr/local/bin/node)")}"
MESH_HOME="${AGENT_MESH_HOME:-$HOME/.agent-mesh}"
UI_PORT="${AGENT_MESH_UI_PORT:-4747}"
SYNC_MAIN="${AGENT_MESH_SUPERVISOR_SYNC:-0}"
# homebrew on PATH for git-lfs: without it the ff-merge aborts mid-checkout and leaves
# LFS files deleted in the tree, which then blocks every later sync as "dirty".
# ~/.superset/bin so a daemon launched from here can run the `superset` CLI: managed
# delivery into a Superset terminal is done by the daemon, in the daemon's environment.
export PATH="$NODE_BIN:$HOME/.local/bin:$HOME/.superset/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
TSX="$REPO/node_modules/tsx/dist/cli.mjs"
# $REPO is interpolated into `grep -E` matchers below: escape ERE metacharacters so a
# checkout path with `+`, `(` or `[` still matches literally.
REPO_RE=$(printf '%s' "$REPO" | sed 's/[][\.*^$+?(){}|\/]/\\&/g')
LOG="$MESH_HOME/supervisor.log"
DAEMON_LOG="$MESH_HOME/daemon.log"
UI_LOG="$MESH_HOME/ui.log"
STRIKES="$MESH_HOME/daemon.unhealthy"
mkdir -p "$MESH_HOME"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# ---- (a) keep base main synced ----------------------------------------------
# Kill a process and everything it spawned, TERM then KILL. `pgrep -P` walks the tree:
# killing only the parent leaves a blocked `git fetch` (and its git-remote-https child)
# running, which then looks like a cleared job while it still holds locks.
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null
  sleep 0.2
  kill -KILL "$pid" 2>/dev/null
}

# Run a command under a wall-clock deadline (seconds). macOS has no `timeout`, and git's
# own knobs are not enough: http.lowSpeed* bounds the transfer only AFTER bytes flow, so a
# DNS / TCP-connect / TLS stall — the actual half-up-network hang — slips past it, and on an
# SSH remote the http.* options are ignored entirely. Returns 124 when the deadline hits.
run_bounded() {
  local secs=$1; shift
  "$@" & local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$((secs * 2))" ]; then
      kill_tree "$pid"
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  wait "$pid"
}

sync_main() {
  cd "$REPO" || { log "sync: repo missing"; return; }
  local branch; branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$branch" != "main" ]; then log "sync: skip (on $branch)"; return; fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then log "sync: skip (dirty)"; return; fi
  # A laptop wakes with the network half-up often enough that an unbounded fetch sits there
  # for minutes. The 60s wall-clock deadline is the real guard (see run_bounded); the git
  # knobs below are belt-and-braces for their own cases: http.lowSpeed* for a transfer that
  # stalls mid-stream over HTTPS, ssh ConnectTimeout/ServerAlive for an SSH remote, and
  # GIT_TERMINAL_PROMPT=0 for a credential prompt nobody can answer.
  local rc
  GIT_TERMINAL_PROMPT=0 \
  GIT_SSH_COMMAND="ssh -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3" \
    run_bounded 60 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
      fetch -q origin main 2>>"$LOG"
  rc=$?
  if [ "$rc" -eq 124 ]; then log "sync: fetch timed out after 60s"; return; fi
  if [ "$rc" -ne 0 ]; then log "sync: fetch failed"; return; fi
  local before after merge_deadline=120; before=$(git rev-parse HEAD)
  # The merge gets a deadline too: its checkout runs the git-lfs smudge filter, which
  # fetches LFS objects over the network and stalls on a half-up link exactly like the
  # fetch does. 120s covers a large checkout on a slow link; the deadline is what
  # matters, the number is not tuned.
  run_bounded "$merge_deadline" git merge -q --ff-only origin/main >>"$LOG" 2>&1
  rc=$?
  after=$(git rev-parse HEAD)
  if [ "$rc" -eq 0 ]; then
    if [ "$before" = "$after" ]; then log "sync: up to date (${after:0:10})"; else log "sync: ${before:0:10} -> ${after:0:10}"; fi
    return
  fi
  if [ "$rc" -eq 124 ]; then log "sync: merge timed out after ${merge_deadline}s"; else log "sync: ff-only merge failed (rc=$rc — diverged, or see the git output above)"; fi
  recover_aborted_merge "$before" "$rc"
}

# A ff-only merge killed mid-checkout leaves the tree half-updated with HEAD still on
# the old commit, and every later pass then skips as dirty with nothing to clear it.
# Undo only what the merge itself wrote, proven per path — a human may have edited a
# file while the merge ran, and that edit must survive:
#   - a modified or untracked path whose content hashes to the origin/main blob was
#     written by the merge (`hash-object --path` applies the clean filter, so an LFS
#     file compares by pointer): restore it from HEAD / remove it;
#   - a deletion that origin/main also makes was the merge's: restore from HEAD;
#   - anything else is not provably the merge's and stays, counted for a human — this
#     includes an LFS file whose smudge was cut off, which then blocks the sync until
#     someone looks, rather than being guessed at.
# Nothing is touched when HEAD moved or anything is staged: a killed checkout leaves the
# index alone (git writes it atomically), so staged changes are somebody's work.
recover_aborted_merge() {
  local head_before=$1 rc=$2
  if [ "$(git rev-parse HEAD)" != "$head_before" ]; then
    log "sync: HEAD moved during the failed merge -> leaving the tree alone"; return
  fi
  # Our own killed child cannot have released its lock; a lock left by anything else
  # belongs to a live git and stays.
  [ "$rc" -eq 124 ] && rm -f "$REPO/.git/index.lock"
  if ! git diff --cached --quiet; then
    log "sync: staged changes present after the failed merge -> leaving the tree alone"; return
  fi
  local restored=0 removed=0 kept=0 entry status path target
  merge_wrote() { [ -n "$2" ] && [ "$(git hash-object --path "$1" -- "$1" 2>/dev/null)" = "$2" ]; }
  # -z: one "XY path" record per NUL; a rename/copy carries a second path record, which
  # cannot occur here (the index is untouched) but is consumed rather than misparsed.
  while IFS= read -r -d '' entry; do
    status=${entry:0:2}; path=${entry:3}
    case "$status" in R*|C*) IFS= read -r -d '' _; kept=$((kept + 1)); continue ;; esac
    target=$(git rev-parse -q --verify "origin/main:$path" 2>/dev/null)
    case "$status" in
      " M"|" T")
        if merge_wrote "$path" "$target"; then git checkout -q HEAD -- "$path"; restored=$((restored + 1)); else kept=$((kept + 1)); fi ;;
      " D")
        if [ -z "$target" ]; then git checkout -q HEAD -- "$path"; restored=$((restored + 1)); else kept=$((kept + 1)); fi ;;
      "??")
        # Untracked files the merge would not create are unrelated, not "kept".
        [ -n "$target" ] || continue
        if merge_wrote "$path" "$target"; then rm -f -- "$path"; removed=$((removed + 1)); else kept=$((kept + 1)); fi ;;
      *) kept=$((kept + 1)) ;;
    esac
  done < <(git status --porcelain=v1 -z --untracked-files=all)
  log "sync: aborted merge undone — restored $restored, removed $removed merge-created untracked, left $kept for a human; retrying next run"
}

# ---- (b) daemon health / restart --------------------------------------------
healthy() {
  # `timeout` isn't on macOS by default; the CLI itself fails fast on a dead socket.
  (cd "$REPO/agent-mesh" && node "$TSX" src/cli.ts health 2>/dev/null | grep -q '"ok": true')
}

# The broker must resolve before a restart can help: a fresh daemon blocks on the
# Redis connect BEFORE it binds its socket, so relaunching without DNS (a laptop's
# dark wakes have no tailnet) only produces a daemon that looks dead for longer.
redis_host() {
  grep -oE 'AGENT_MESH_REDIS_URL=[^ ]+' "$MESH_HOME/daemon.env" 2>/dev/null \
    | sed -E 's#^[^=]+=rediss?://([^@]*@)?([^:/]+).*#\2#'
}
broker_resolves() {
  local host; host=$(redis_host)
  [ -n "$host" ] && nslookup -timeout=3 "$host" >/dev/null 2>&1
}

kill_daemon() {
  local pids
  # The cmdline match is the ONLY selector — daemon.pid is deliberately not read: after an
  # unclean exit the number can belong to an unrelated process. Scoped to THIS repo (the
  # node procs report comm=MainThread, so a comm filter misses them; another checkout's
  # daemon must not match) and catching both the tsx wrapper and its
  # `node --require <repo>/… src/daemon.ts` child. Exclude shells and ourselves so we never
  # self-match the way `pkill -f` would.
  pids="$(ps -eo pid=,command= | grep -E "node .*$REPO_RE/.*src/daemon\.ts" | grep -vE '(^| )(bash|sh|zsh)( |$)|grep' | awk -v me=$$ '$1!=me{print $1}')"
  # Signal matched pids only — never the process group. A daemon started by some other
  # script shares THAT script's group, and a group kill would take the launcher and any
  # unrelated siblings with it. The match above already covers wrapper + child, which is
  # everything that needs to die.
  for p in $pids; do
    [ -z "$p" ] && continue
    log "restart: killing pid=$p"
    kill -TERM "$p" 2>/dev/null
  done
  sleep 2
  for p in $pids; do [ -n "$p" ] && kill -KILL "$p" 2>/dev/null; done
  rm -f "$MESH_HOME/daemon.pid" "$MESH_HOME/daemon.sock"
}

start_daemon() {
  if [ -f "$MESH_HOME/daemon.env" ]; then set -a; . "$MESH_HOME/daemon.env"; set +a; fi
  cd "$REPO/agent-mesh" || { log "restart: agent-mesh dir missing"; return; }
  # nohup + all fds redirected: the daemon must not inherit anything from this run.
  nohup node "$TSX" src/daemon.ts >>"$DAEMON_LOG" 2>&1 </dev/null &
  disown 2>/dev/null || true
  record_mesh_commit
  log "restart: launched daemon pid=$! on mesh code $(cut -c1-10 "$MESH_COMMIT_FILE")"
  sleep 4
  healthy && log "restart: healthy" || log "restart: STILL UNHEALTHY"
}

# ---- (d) mesh code currency ---------------------------------------------------
# The liveness check never restarts a daemon that keeps answering its health probe, so
# left to itself the daemon runs whatever code it was launched with while main moves on.
# The commit that last touched agent-mesh/ is recorded when the daemon is launched here
# and compared with the synced main on every pass. A restart is deliberate downtime: every
# legacy `agent-mesh watch` on the host dies with the daemon (managed bindings are
# restored from local persistence), so the host's orchestrator re-arms after a `restart:` line.
MESH_COMMIT_FILE="$MESH_HOME/daemon.commit"
mesh_code_commit() { git -C "$REPO" log -1 --format=%H -- agent-mesh/ 2>/dev/null; }
record_mesh_commit() { mesh_code_commit > "$MESH_COMMIT_FILE"; }

ensure_mesh_code_current() {
  local current running
  current=$(mesh_code_commit)
  [ -n "$current" ] || return
  if [ ! -f "$MESH_COMMIT_FILE" ]; then
    # A daemon started outside this script (start-local.sh, by hand) has no record:
    # adopt what is on disk as its code instead of bouncing every watcher on the first
    # pass after install. If it really is older, the next agent-mesh/ commit catches it.
    record_mesh_commit
    log "currency: adopted mesh code ${current:0:10} for the running daemon"
    return
  fi
  running=$(cat "$MESH_COMMIT_FILE")
  [ "$running" != "$current" ] || return
  if ! healthy || ! broker_resolves; then
    log "currency: mesh code ${running:0:10} -> ${current:0:10} but daemon unhealthy/offline -> deferring"
    return
  fi
  log "restart: mesh code ${running:0:10} -> ${current:0:10} -> restarting daemon + ui"
  # start_ui otherwise builds only when dist is missing. The old dist is kept rather
  # than deleted so a failed rebuild still leaves a dashboard to serve.
  if [ -n "$(git -C "$REPO" diff --name-only "$running" "$current" -- agent-mesh/dashboard/ 2>/dev/null)" ]; then
    UI_REBUILD=1
    log "ui: dashboard source changed -> rebuilding"
  fi
  kill_daemon
  start_daemon
  kill_ui
  start_ui
}

# ---- (e) shared CLI wrapper ---------------------------------------------------
# ~/.local/bin/agent-mesh is host-wide, and every agent's bootstrap rewrites it to point
# at ITS worktree (`install_cli_wrapper "$REPO"`); when that worktree is deleted or
# falls behind main, every CLI call on the host breaks or runs old code. The base
# checkout is the one copy this script keeps current, so each pass points the wrapper
# back at it. Test a worktree's CLI by calling it directly
# (`cd <worktree>/agent-mesh && node ../node_modules/tsx/dist/cli.mjs src/cli.ts …`),
# not via the wrapper.
ensure_cli_wrapper() {
  local installed="$HOME/.local/bin/agent-mesh" have tmp expected
  have=$(grep -o 'pnpm --dir "[^"]*' "$installed" 2>/dev/null | cut -d'"' -f2)
  # Compare against what the installer would write today rather than against a path or
  # a marker: any change to the wrapper (target, exec shape, identity guards) then
  # reaches every supervised host on its next pass, not only the change that added
  # the marker. Rendering into a scratch HOME keeps the installer's own
  # "don't repoint a shared wrapper at a worktree" check out of the comparison.
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/mesh-wrapper.XXXXXX") || return
  # install_cli_wrapper only reaches for pnpm when the repo has no tsx at all, which
  # this script already requires — so the no-pnpm rule in the header holds.
  # shellcheck source=lib/mesh-bootstrap.sh
  ( HOME="$tmp"; . "$REPO/agent-mesh/lib/mesh-bootstrap.sh" && install_cli_wrapper "$REPO" ) >/dev/null 2>&1
  expected="$tmp/.local/bin/agent-mesh"
  if [ -f "$expected" ] && ! cmp -s "$expected" "$installed"; then
    . "$REPO/agent-mesh/lib/mesh-bootstrap.sh" && install_cli_wrapper "$REPO" >/dev/null 2>&1
    log "cli: wrapper refreshed -> $REPO/agent-mesh (was ${have:-unset})"
  fi
  rm -rf "$tmp"
}

# ---- (c) dashboard UI health / restart ---------------------------------------
ui_healthy() { curl -s -m 3 -o /dev/null "http://127.0.0.1:$UI_PORT/"; }

kill_ui() {
  local pids
  # Scoped to THIS repo so another checkout's UI is never touched, and matching the
  # child too: the tsx wrapper's `node --require <repo>/… src/ui-server.ts` child is the
  # real listener and outlives a wrapper-only kill.
  pids="$(ps -eo pid=,command= | grep -E "node .*$REPO_RE/.*src/ui-server\.ts" | grep -vE '(^| )(bash|sh|zsh)( |$)|grep' | awk -v me=$$ '$1!=me{print $1}')"
  for p in $pids; do
    log "ui: killing pid=$p"
    kill -TERM "$p" 2>/dev/null
  done
  sleep 1
  for p in $pids; do kill -KILL "$p" 2>/dev/null; done
}

UI_REBUILD=0
start_ui() {
  cd "$REPO/agent-mesh" || { log "ui: agent-mesh dir missing"; return; }
  # Build only when dist is missing or the currency check saw the dashboard source move
  # (a rebuild every run is wasteful), and only via the dashboard's own vite — never
  # pnpm (see header). vite's JS entry, not `node_modules/.bin/vite`: the .bin file is a
  # shell shim, and node fed a shell script fails with a SyntaxError before building.
  # This script cannot install dashboard dependencies, so a rebuild that needs a new
  # one fails here; vite fails before it empties dist, and the previous build is served.
  if [ ! -f dashboard/dist/index.html ] || [ "$UI_REBUILD" = 1 ]; then
    if [ -f dashboard/node_modules/vite/bin/vite.js ]; then
      log "ui: building dashboard"
      if ! (cd dashboard && node node_modules/vite/bin/vite.js build >>"$UI_LOG" 2>&1); then
        if [ -f dashboard/dist/index.html ]; then
          log "ui: build FAILED (see ui.log) -> serving the previous build; if dashboard deps changed run 'pnpm --dir agent-mesh ui:deps' once interactively"
        else
          log "ui: build FAILED (see ui.log); if dashboard deps changed run 'pnpm --dir agent-mesh ui:deps' once interactively"; return
        fi
      fi
    else
      log "ui: no dashboard/dist and no vite — run 'pnpm --dir agent-mesh ui:deps' once interactively"; return
    fi
  fi
  AGENT_MESH_UI_PORT="$UI_PORT" nohup node "$TSX" src/ui-server.ts >>"$UI_LOG" 2>&1 </dev/null &
  disown 2>/dev/null || true
  log "ui: launched pid=$!"
  sleep 3
  ui_healthy && log "ui: healthy" || log "ui: STILL UNHEALTHY"
}

# ---- run ---------------------------------------------------------------------
# Recovery first, sync last. The daemon and UI checks are what actually keep this host on
# the mesh; the git sync is a convenience. Running sync first meant a slow network could
# delay — or, before the deadline above, indefinitely postpone — the checks that matter.
if healthy; then
  log "daemon: healthy"
  rm -f "$STRIKES"
elif ! broker_resolves; then
  # Offline: a restart cannot succeed. Not a strike either — a 2-second dark wake must
  # never look like two real failures.
  log "daemon: probe failed but broker host does not resolve (offline) -> leaving daemon alone"
else
  # Two consecutive failed probes (across two runs, >= one interval apart) before killing:
  # a single failed probe has killed a healthy daemon during a dark wake, which bounces
  # in-flight socket requests. Surviving watches retry with backoff; managed
  # pending wakeups/timers restore from local state, but ambiguous sends stay held.
  n=$(( $(cat "$STRIKES" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$STRIKES"
  if [ "$n" -lt 2 ]; then
    log "daemon: UNHEALTHY (strike $n/2) -> waiting for next run"
  else
    log "daemon: UNHEALTHY (strike $n/2) -> restarting"
    rm -f "$STRIKES"
    kill_daemon
    start_daemon
  fi
fi

if ui_healthy; then
  log "ui: healthy"
else
  log "ui: UNHEALTHY -> restarting"
  kill_ui
  start_ui
fi

if [ "$SYNC_MAIN" = 1 ]; then
  sync_main
fi
# After the sync, so a restart lands on the code main just moved to. Without the sync
# it still restarts onto code someone pulled by hand.
ensure_mesh_code_current
ensure_cli_wrapper
