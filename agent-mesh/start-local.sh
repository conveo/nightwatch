#!/usr/bin/env bash
# Start a per-host agent-mesh daemon and join a mesh. Run it in its own terminal;
# Ctrl-C stops it.
#
#   AGENT_MESH_REDIS_URL=redis://my-broker:6379 ./agent-mesh/start-local.sh   # join a shared mesh
#   ./agent-mesh/start-local.sh --local                                     # localhost:6379
#
# Override anything via env:
#   AGENT_MESH_REDIS_URL  — broker URL (required unless --local)
#   AGENT_MESH_ID         — your agent id        (default: "<you>-laptop")
#   AGENT_MESH_HOSTNAME   — host label in roster (default: $(hostname))
set -euo pipefail
cd "$(dirname "$0")/.." # repo root
REPO="$(pwd)"
source "$REPO/agent-mesh/lib/mesh-bootstrap.sh"

if [[ "${1:-}" == "--local" ]]; then
  : "${AGENT_MESH_REDIS_URL:=redis://localhost:6379}"
  export AGENT_MESH_REDIS_URL
  echo "mode: LOCAL (isolated broker configured)"
else
  resolve_mesh_url   # AGENT_MESH_REDIS_URL, else the script named by AGENT_MESH_SITE_HOOK
  echo "mode: shared mesh (broker configured)"
fi
export AGENT_MESH_HOSTNAME="${AGENT_MESH_HOSTNAME:-$(hostname)}"
if [[ -z "${CLAUDE_CODE_SESSION_ID:-}${CODEX_THREAD_ID:-}${AGENT_MESH_NATIVE_SESSION:-}${SUPERSET_TERMINAL_ID:-}${HERDR_PANE_ID:-}" ]]; then
  export AGENT_MESH_ID="${AGENT_MESH_ID:-$(whoami)-laptop}"
fi

# Install the CLI wrapper on PATH + persist AGENT_MESH_ID as this laptop's default
# identity (so a fresh terminal that sets nothing already knows your id).
install_cli_wrapper "$REPO"
if [[ -z "${CLAUDE_CODE_SESSION_ID:-}${CODEX_THREAD_ID:-}${AGENT_MESH_NATIVE_SESSION:-}${SUPERSET_TERMINAL_ID:-}${HERDR_PANE_ID:-}" ]]; then
  persist_cli_identity
fi

echo
echo "agent id : ${AGENT_MESH_ID:-runtime-derived}"
echo "host     : $AGENT_MESH_HOSTNAME"
echo "CLI      : installed at ~/.local/bin/agent-mesh"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) : ;;
  *) echo "         (add ~/.local/bin to PATH:  export PATH=\"\$HOME/.local/bin:\$PATH\")" ;;
esac
echo
echo "in another terminal:"
echo "  agent-mesh register --role human --deliver auto"
echo "  agent-mesh agents          # see everyone on the mesh"
echo "  agent-mesh inbox           # read messages addressed to you"
echo
echo "starting daemon (Ctrl-C to stop)…"
exec pnpm --dir agent-mesh daemon
