#!/usr/bin/env bash
# Read-only delivery readiness in the RECEIVING actor's host context.
# Cross-host receive/reply and spawning proof still belong in the run log.
#
#   AGENT_MESH_ID=<actor> ./agent-mesh/preflight.sh                      # orchestrator
#   AGENT_MESH_ID=<actor> MESH_REQUIRE_TICK=0 ./agent-mesh/preflight.sh  # other roles
#
# Inputs: AGENT_MESH_ID (default: the wrapper's own identity) and
# MESH_REQUIRE_TICK (default 1). Nothing else is read.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
# An older version of this script took these and checked the remote side; a run
# following an old copy of the instructions must not read a pass as covering them.
for obsolete in REMOTE_ORCHESTRATOR_ID SCOPE REMOTE_BACKEND REVIEW_WORKTREE; do
  if [[ -n "${!obsolete:-}" ]]; then
    echo "preflight: $obsolete is not read by this script; check the remote orchestrator, the run log and the backend by hand (nightwatch Phase 4)" >&2
  fi
done
args=(delivery)
[[ -n "${AGENT_MESH_ID:-}" ]] && args+=(--id "$AGENT_MESH_ID")
status="$(agent-mesh "${args[@]}")"
printf '%s\n' "$status"
if ! jq -e '
  .owns == true and .automaticWakeup == true and .receiptConfirmed == true and
  .targetVerification.reason == "verified-dedicated-agent" and
  (.state.lastReceipt.at > ((now * 1000) - 300000)) and
  (.state.batch == null or (.state.batch.outcome != "ambiguous" and .state.batch.outcome != "exhausted"))
' <<<"$status" >/dev/null; then
  echo "NOT READY: require a currently verified idle adapter and a receipt within five minutes; inspect pending errors. Monitor proof must be recorded through the actual harness; polling-only is not unattended." >&2
  exit 1
fi
if [[ "${MESH_REQUIRE_TICK:-1}" == "1" ]] && ! jq -e '.tickReady == true' <<<"$status" >/dev/null; then
  echo "NOT READY: receive and ACK a daemon clock-only tick. Set MESH_REQUIRE_TICK=0 only for a non-orchestrator role." >&2
  exit 1
fi
echo "Local delivery proof present. Confirm the run log's cross-host receive/reply, actual spawner CLI access, cwd/base, authentication, and recovery limitations before unattended operation."
