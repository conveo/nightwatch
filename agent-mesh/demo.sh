#!/usr/bin/env bash
# Runnable demo of the agent-mesh, driven entirely through the CLI (as agents do).
# Shows: daemon owns Redis · agents register & are discoverable · worker hits a
# blocker → orchestrator decides → worker resolves · DIRECT injection into a
# running process via a fifo (stand-in for a live Claude session).
#
#   AGENT_MESH_REDIS_URL=redis://localhost:6379 ./demo.sh
#
# Requires: a reachable Redis, tsx (resolved from the repo root node_modules).
set -euo pipefail
cd "$(dirname "$0")"

export AGENT_MESH_REDIS_URL="${AGENT_MESH_REDIS_URL:-redis://localhost:6379}"
export AGENT_MESH_PREFIX="${AGENT_MESH_PREFIX:-meshdemo}"
HOME_DIR="$(mktemp -d -t agent-mesh-demo-XXXX)"
export AGENT_MESH_HOME="$HOME_DIR"
export AGENT_MESH_SOCK="$HOME_DIR/daemon.sock"
export AGENT_MESH_HOSTNAME="demo-host"
FIFO="$HOME_DIR/worker-a.fifo"
TSX="pnpm exec tsx"

cli() { $TSX src/cli.ts "$@"; }

cleanup() {
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null || true
  [[ -n "${READER_PID:-}" ]] && kill "$READER_PID" 2>/dev/null || true
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

echo "=== agent-mesh demo (Redis=$AGENT_MESH_REDIS_URL, prefix=$AGENT_MESH_PREFIX) ==="
echo

echo "1) start the daemon (it owns the only Redis connection on this host)"
$TSX src/daemon.ts >"$HOME_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
disown "$DAEMON_PID" 2>/dev/null || true
# wait for the socket
for _ in $(seq 1 50); do [[ -S "$AGENT_MESH_SOCK" ]] && break; sleep 0.1; done
cli health | sed 's/^/   /'
echo

echo "2) a 'running Claude process' for worker-a: a fifo reader (stand-in for the live session)"
mkfifo "$FIFO"
$TSX src/test/fifo-reader.ts "$FIFO" worker-a &
READER_PID=$!
disown "$READER_PID" 2>/dev/null || true
sleep 0.3

echo
echo "3) register two agents through the local socket (no direct Redis):"
AGENT_MESH_ID=orchestrator cli register --role orchestrator --meta host=laptop
AGENT_MESH_ID=worker-a    cli register --role implementer --meta ticket=T-1 --deliver "fifo:$FIFO"
echo
echo "   discoverable across the mesh:"
cli agents | sed 's/^/   /'

echo
echo "4) worker-a hits a blocker and publishes it to the orchestrator:"
AGENT_MESH_ID=worker-a cli publish --to orchestrator --type blocker --corr blk-1 \
  --body '{"q":"SQLite cant span hosts — which transport?","options":["sqlite","redis-streams","pg-notify"]}'
sleep 0.6
echo "   orchestrator reads its inbox:"
AGENT_MESH_ID=orchestrator cli inbox | sed 's/^/   /'

echo
echo "5) orchestrator decides and replies on the thread → DIRECTLY injected into worker-a's process:"
AGENT_MESH_ID=orchestrator cli publish --to worker-a --type decision --corr blk-1 \
  --body '{"choice":"redis-streams","why":"cross-host, reuse existing infra"}'
sleep 0.8   # the [worker-a <- injected via fifo] line below is the daemon pushing into the live process
echo
echo "   worker-a also has it durably in its inbox (backstop):"
AGENT_MESH_ID=worker-a cli inbox | sed 's/^/   /'

echo
echo "=== demo complete ==="
