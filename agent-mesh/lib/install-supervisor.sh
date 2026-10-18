#!/usr/bin/env bash
# Install (or refresh) the agent-mesh host supervisor as a macOS launchd job that runs
# ../supervisor.sh every 5 minutes. Idempotent — re-run after changing paths.
#
#   ./agent-mesh/lib/install-supervisor.sh            # install for this repo + this node
#   ./agent-mesh/lib/install-supervisor.sh --uninstall
#
# The job points at the supervisor INSIDE the repo it syncs, so the script updates with
# main. The env values below are baked into the plist because launchd runs with no shell
# rc (no nvm, no PATH); `node` must be given as an absolute directory.
#   AGENT_MESH_SUPERVISOR_REPO  repo to sync + run from   (default: this checkout)
#   AGENT_MESH_SUPERVISOR_NODE  dir containing `node`     (default: dirname of `command -v node`)
#   AGENT_MESH_SUPERVISOR_SYNC  1 = fast-forward main to origin/main on every run (default 0)
#   AGENT_MESH_HOME             daemon home               (default: ~/.agent-mesh)
set -euo pipefail

LABEL=local.agent-mesh.supervisor
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL (the daemon and UI keep running; they just aren't supervised any more)"
  exit 0
fi

[[ "$(uname)" == "Darwin" ]] || { echo "launchd installer is macOS-only; on Linux add a cron line: */5 * * * * AGENT_MESH_SUPERVISOR_REPO=… AGENT_MESH_SUPERVISOR_NODE=… bash <repo>/agent-mesh/supervisor.sh" >&2; exit 1; }

REPO="${AGENT_MESH_SUPERVISOR_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
NODE_DIR="${AGENT_MESH_SUPERVISOR_NODE:-$(dirname "$(command -v node)")}"
SYNC_MAIN="${AGENT_MESH_SUPERVISOR_SYNC:-0}"
MESH_HOME="${AGENT_MESH_HOME:-$HOME/.agent-mesh}"
SCRIPT="$REPO/agent-mesh/supervisor.sh"

[[ -x "$NODE_DIR/node" ]] || { echo "no node binary in $NODE_DIR" >&2; exit 1; }
[[ -f "$SCRIPT" ]] || { echo "missing $SCRIPT" >&2; exit 1; }
[[ -f "$REPO/node_modules/tsx/dist/cli.mjs" ]] || { echo "$REPO has no node_modules/tsx — run pnpm install there first" >&2; exit 1; }
mkdir -p "$(dirname "$PLIST")" "$MESH_HOME"

# The supervisor relaunches the daemon from $MESH_HOME/daemon.env (broker URL, host
# label, claude binary for resume delivery). Nothing else writes that file — start-local.sh
# only persists cli.env — so create it here from the resolved broker URL when missing.
if [[ ! -f "$MESH_HOME/daemon.env" ]]; then
  source "$REPO/agent-mesh/lib/mesh-bootstrap.sh"
  resolve_mesh_url # AGENT_MESH_REDIS_URL, else the script named by AGENT_MESH_SITE_HOOK
  {
    printf 'AGENT_MESH_REDIS_URL=%s\n' "$AGENT_MESH_REDIS_URL"
    printf 'AGENT_MESH_HOSTNAME=%s\n' "${AGENT_MESH_HOSTNAME:-$(hostname)}"
    printf 'AGENT_MESH_CLAUDE_BIN=%s\n' "${AGENT_MESH_CLAUDE_BIN:-$(command -v claude || echo claude)}"
  } > "$MESH_HOME/daemon.env"
  chmod 600 "$MESH_HOME/daemon.env"
  echo "wrote $MESH_HOME/daemon.env"
fi

# Refresh protocol, ordered so the common failure never leaves the host unsupervised:
#   1. wait for any in-flight supervisor pass to finish BEFORE booting the job out — if it
#      never finishes we abort with the old job still loaded and still supervising;
#   2. back up the plist, boot the job out, and re-check (launchd can have started a pass
#      in the moments before the bootout landed);
#   3. write + lint the new plist and run one validation pass in launchd's bare env;
#   4. only then bootstrap. Anything that fails in 2-4 restores and reloads the backup.
# Two passes must never overlap: they race on the $MESH_HOME strike file and on the daemon
# and UI lifecycles.

# Count a process only when the script is the SHELL'S ARGUMENT — `<shell> <…/supervisor.sh>`,
# how launchd and the validation run it (a shebang exec reports the interpreter the same
# way) — or when the script is the program itself. Matching the END of the command line
# rather than a whitespace-split field keeps this correct for a checkout path containing
# spaces; `$3 != "-c"` drops a shell whose -c STRING merely mentions the path, and the prog
# check drops an editor, a grep or ugrep, and the shell you typed the install command into.
# Any agent-mesh/supervisor.sh counts, not just $SCRIPT: a refresh that repoints
# AGENT_MESH_SUPERVISOR_REPO must still wait out the old path's pass, which races on the
# same state. A pass takes ~15s, so 120s is a generous ceiling.
supervisor_pass_pids() {
  ps -eo pid=,command= | awk -v me=$$ '
    $1 == me { next }
    function base(path,   n, p) { n = split(path, p, "/"); return p[n] }
    $0 !~ /agent-mesh\/supervisor\.sh$/ { next }
    {
      prog = base($2)
      if ($2 ~ /agent-mesh\/supervisor\.sh$/) { print $1; next }
      if ((prog == "bash" || prog == "sh" || prog == "zsh") && $3 != "-c") print $1
    }
  '
}
supervisor_pass_running() { [ -n "$(supervisor_pass_pids)" ]; }

# Returns non-zero if a pass is still running when the ceiling is reached.
wait_for_idle() {
  local waited=0
  while supervisor_pass_running; do
    [ "$waited" -ge 240 ] && return 1
    sleep 0.5
    waited=$((waited + 1))
  done
}

if ! wait_for_idle; then
  # Nothing has been touched yet, so the previous job is still loaded and still
  # supervising — abort plainly rather than taking the host down to install.
  echo "a supervisor pass has been running for over 120s — not installing over it; retry later" >&2
  exit 1
fi

BACKUP=""
if [[ -f "$PLIST" ]]; then
  BACKUP="$(mktemp "${TMPDIR:-/tmp}/$LABEL.plist.XXXXXX")"
  cp "$PLIST" "$BACKUP"
fi
# Call with an explicit code for a deliberate abort; the ERR trap calls it with none, so it
# picks up the failing command's status. Every exit path after the bootout below MUST go
# through here — a bare `exit` would skip the ERR trap and leave no job loaded at all.
restore_previous() {
  local rc=${1:-$?}
  echo "install failed (exit $rc)" >&2
  if [[ -n "$BACKUP" ]]; then
    cp "$BACKUP" "$PLIST"
    launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && echo "restored the previous $LABEL job" >&2
    rm -f "$BACKUP"
  fi
  exit "$rc"
}
trap restore_previous ERR

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# Re-check: a pass may have started just before the bootout landed. No NEW pass can start
# now that the job is out, so this can only be draining.
if ! wait_for_idle; then
  # The job is out, so this pass is orphaned work from a job that no longer exists, and
  # restoring a RunAtLoad plist next to it would put two passes on the same strike file and
  # the same daemon. End it instead: killing the shell leaves the daemon and UI it launched
  # alone (both are nohup'd and disowned), and a half-finished pass is self-healing — the
  # next one re-probes and restarts whatever is actually down.
  echo "a pass started just before bootout and is still running after 120s — ending it" >&2
  # Kill the descendants too. A stuck pass is usually blocked in a foreground child (a git
  # fetch, and under it git-remote-https); killing only the shell leaves that child holding
  # repo locks while the check below happily reports the pass cleared, which is exactly the
  # overlap this block exists to prevent. `AbandonProcessGroup` on the job means launchd
  # will not reap them either.
  #
  # Snapshot the whole victim list BEFORE signalling, and KILL exactly that list afterwards.
  # Re-discovering pids for the KILL sweep does not work: once the supervisor shell dies on
  # TERM its surviving child is reparented, no longer matches the pass matcher, and would
  # escape the sweep entirely.
  # Skip the mesh services and everything under them. `nohup` + `disown` does NOT reparent:
  # a daemon or UI the pass just restarted is still that shell's child until the shell exits,
  # so a naive walk would list the very processes this job exists to keep alive — and since
  # health recovery now runs BEFORE the sync, "restarted the daemon, then blocked in fetch"
  # is the normal shape of a stuck pass, not a corner case.
  is_mesh_service() {
    ps -o command= -p "$1" 2>/dev/null | grep -qE 'src/(daemon|ui-server)\.ts'
  }
  descendants_of() {
    local pid=$1 child
    for child in $(pgrep -P "$pid" 2>/dev/null); do
      is_mesh_service "$child" && continue
      echo "$child"
      descendants_of "$child"
    done
  }
  victims=""
  for pid in $(supervisor_pass_pids); do
    victims="$victims $pid $(descendants_of "$pid" | tr '\n' ' ')"
  done
  for pid in $victims; do kill -TERM "$pid" 2>/dev/null; done
  sleep 2
  for pid in $victims; do kill -KILL "$pid" 2>/dev/null; done
  sleep 1
  # An explicit `if`, not `cmd && restore_previous`: as the last statement of this block a
  # false `&&` list would make the enclosing compound return non-zero and trip the ERR trap.
  if supervisor_pass_running; then
    restore_previous 1 # could not clear it; put the old job back rather than install
  fi
fi

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$(xml "$SCRIPT")</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_MESH_SUPERVISOR_REPO</key><string>$(xml "$REPO")</string>
    <key>AGENT_MESH_SUPERVISOR_NODE</key><string>$(xml "$NODE_DIR")</string>
    <key>AGENT_MESH_SUPERVISOR_SYNC</key><string>$(xml "$SYNC_MAIN")</string>
    <key>AGENT_MESH_HOME</key><string>$(xml "$MESH_HOME")</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$(xml "$MESH_HOME")/supervisor.launchd.log</string>
  <key>StandardErrorPath</key><string>$(xml "$MESH_HOME")/supervisor.launchd.log</string>
</dict>
</plist>
EOF
plutil -lint -s "$PLIST" >/dev/null

env -i HOME="$HOME" AGENT_MESH_SUPERVISOR_REPO="$REPO" AGENT_MESH_SUPERVISOR_NODE="$NODE_DIR" AGENT_MESH_SUPERVISOR_SYNC="$SYNC_MAIN" AGENT_MESH_HOME="$MESH_HOME" /bin/bash "$SCRIPT"
echo "validation run:"; tail -n 3 "$MESH_HOME/supervisor.log"

launchctl bootstrap "$DOMAIN" "$PLIST"
trap - ERR
[[ -n "$BACKUP" ]] && rm -f "$BACKUP"
echo "installed $LABEL -> $SCRIPT (every 300s)"
echo "check:   launchctl print $DOMAIN/$LABEL | grep 'last exit'"
