#!/usr/bin/env bash
# verify.sh — the whole thesis in one script.
#
# From a clean checkout of THIS directory alone, it:
#   1. brings up a local Redis (reuses $AGENT_MESH_REDIS_URL, else Docker, else a
#      local redis-server binary),
#   2. installs deps if needed and boots the per-host daemon,
#   3. registers two agents,
#   4. passes a message from one to the other and back on a thread,
#   5. receives a managed batch and acknowledges it with a receipt,
#   6. asserts every step, and exits NON-ZERO on any failure.
#
#   ./verify.sh
#   AGENT_MESH_REDIS_URL=redis://localhost:6379 ./verify.sh   # use your own Redis
#
# No arguments. No network beyond the Redis it uses. Idempotent; cleans up after itself.
set -euo pipefail
cd "$(dirname "$0")"

# Run as a plain shell even when started from inside an agent session or a
# Superset/Herdr pane: with these markers set, `register --deliver auto` would
# try to bind the test actors to the caller's own session.
unset CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID AGENT_MESH_NATIVE_SESSION AGENT_MESH_ID \
  SUPERSET_TERMINAL_ID SUPERSET_WORKSPACE_ID SUPERSET_TAB_ID \
  HERDR_PANE_ID HERDR_ENV HERDR_SOCKET_PATH HERDR_TAB_ID HERDR_WORKSPACE_ID

PASS=0
FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1" >&2; FAIL=$((FAIL + 1)); }
die()  { echo "FATAL: $1" >&2; exit 1; }

# --- isolated runtime state (never touches a real mesh) -----------------------
HOME_DIR="$(mktemp -d -t agent-mesh-verify-XXXX)"
export AGENT_MESH_HOME="$HOME_DIR"
export AGENT_MESH_SOCK="$HOME_DIR/daemon.sock"
export AGENT_MESH_PREFIX="verify-$$"
export AGENT_MESH_HOSTNAME="verify-host"
TOKEN="tok-$$-$RANDOM"          # unique payload we chase through the mesh
CORR="corr-$$-$RANDOM"

REDIS_CID=""
REDIS_PID=""
DAEMON_PID=""

cleanup() {
  [[ -n "$DAEMON_PID" ]] && kill "$DAEMON_PID" 2>/dev/null || true
  [[ -n "$REDIS_CID" ]] && docker rm -f "$REDIS_CID" >/dev/null 2>&1 || true
  [[ -n "$REDIS_PID" ]] && kill "$REDIS_PID" 2>/dev/null || true
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

# --- 1) Redis ----------------------------------------------------------------
echo "1) Redis broker"
if [[ -n "${AGENT_MESH_REDIS_URL:-}" ]]; then
  echo "   using provided AGENT_MESH_REDIS_URL"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  REDIS_CID="$(docker run -d --rm -p 127.0.0.1::6379 "${AGENT_MESH_VERIFY_REDIS_IMAGE:-redis:7.2-alpine}")" \
    || die "could not start a Docker Redis"
  port="$(docker port "$REDIS_CID" 6379/tcp | head -1 | sed 's/.*://')"
  [[ -n "$port" ]] || die "could not read the mapped Redis port"
  export AGENT_MESH_REDIS_URL="redis://127.0.0.1:$port"
  echo "   started Docker Redis at $AGENT_MESH_REDIS_URL"
elif command -v redis-server >/dev/null 2>&1; then
  port=6399
  redis-server --bind 127.0.0.1 --port "$port" --save '' --appendonly no >"$HOME_DIR/redis.log" 2>&1 &
  REDIS_PID=$!
  export AGENT_MESH_REDIS_URL="redis://127.0.0.1:$port"
  echo "   started local redis-server at $AGENT_MESH_REDIS_URL"
else
  die "no Redis available. Set AGENT_MESH_REDIS_URL, or install Docker or redis-server."
fi

# --- 2) deps + build + daemon ------------------------------------------------
# verify runs the COMPILED output with plain `node` (tsc → dist/). This needs no
# esbuild/tsx build step, so it is portable across pnpm/npm versions; `pnpm dev`
# still uses tsx directly for iteration.
echo "2) deps + build"
LOG="$HOME_DIR/install.log"
if [[ ! -x node_modules/.bin/tsc ]]; then
  echo "   installing deps…"
  # A package manager may exit non-zero merely for an unapproved dependency build
  # script (esbuild, pulled in by tsx). That does not stop tsc/node from working,
  # so tolerate it here and gate on tsc actually being present instead.
  if command -v pnpm >/dev/null 2>&1; then pnpm install >"$LOG" 2>&1 || true
  else npm install >"$LOG" 2>&1 || true; fi
fi
[[ -x node_modules/.bin/tsc ]] || { cat "$LOG" >&2; die "typescript not installed (see $LOG)"; }
node_modules/.bin/tsc >>"$LOG" 2>&1 || { cat "$LOG" >&2; die "tsc build failed (see $LOG)"; }
[[ -f dist/daemon.js && -f dist/cli.js ]] || die "build produced no dist/daemon.js + dist/cli.js"
pass "package builds standalone (tsc → dist)"

cli() { node dist/cli.js "$@"; }

node dist/daemon.js >"$HOME_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 100); do [[ -S "$AGENT_MESH_SOCK" ]] && break; sleep 0.1; done
[[ -S "$AGENT_MESH_SOCK" ]] || { cat "$HOME_DIR/daemon.log" >&2; die "daemon socket never appeared"; }
if cli health >/dev/null 2>&1; then pass "daemon healthy on its socket"; else fail "daemon health check failed"; fi

# --- 3) register two agents --------------------------------------------------
echo "3) register two agents"
AGENT_MESH_ID=alice cli register --role orchestrator >/dev/null 2>&1 && pass "registered alice" || fail "register alice"
AGENT_MESH_ID=bob   cli register --role implementer  >/dev/null 2>&1 && pass "registered bob"   || fail "register bob"

roster="$(AGENT_MESH_ID=alice cli agents 2>/dev/null || true)"
grep -q '^alice' <<<"$roster" && pass "alice on the roster" || fail "alice missing from roster"
grep -q '^bob'   <<<"$roster" && pass "bob on the roster"   || fail "bob missing from roster"

# --- 4) pass a message alice -> bob, then bob -> alice on the same thread -----
echo "4) message passing"
AGENT_MESH_ID=alice cli publish --to bob --type request --corr "$CORR" \
  --body "{\"token\":\"$TOKEN\",\"ask\":\"which transport?\"}" >/dev/null 2>&1 \
  && pass "alice published request" || fail "alice publish failed"

got=""
for _ in $(seq 1 30); do
  if AGENT_MESH_ID=bob cli inbox --peek 2>/dev/null | grep -q "$TOKEN"; then got=1; break; fi
  sleep 0.2
done
[[ -n "$got" ]] && pass "bob received alice's message ($TOKEN)" || fail "bob never received the message"

REPLY="reply-$$-$RANDOM"
AGENT_MESH_ID=bob cli publish --to alice --type decision --corr "$CORR" \
  --body "{\"token\":\"$REPLY\",\"choice\":\"redis-streams\"}" >/dev/null 2>&1 \
  && pass "bob replied on the thread" || fail "bob reply failed"

got=""
for _ in $(seq 1 30); do
  if AGENT_MESH_ID=alice cli inbox --peek 2>/dev/null | grep -q "$REPLY"; then got=1; break; fi
  sleep 0.2
done
[[ -n "$got" ]] && pass "alice received bob's reply ($REPLY)" || fail "alice never received the reply"

# --- 5) managed delivery: receive a batch, then acknowledge it ---------------
# A plain shell has no push endpoint, so `--deliver auto` selects polling. The
# receive/receipt protocol is the same one an adapter-woken agent uses.
echo "5) receive + receipt"
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],JSON.parse(s));console.log(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))})' "$1"; }
AGENT_MESH_ID=carol cli register --role reviewer --deliver auto >/dev/null 2>&1 \
  && pass "registered carol with --deliver auto" || fail "register carol"
GEN="$(AGENT_MESH_ID=carol cli delivery 2>/dev/null | json transport.generation || true)"
[[ -n "$GEN" ]] && pass "carol has a binding generation" || fail "no binding generation for carol"
NOTE="note-$$-$RANDOM"
AGENT_MESH_ID=alice cli publish --to carol --type note --corr "$CORR" --body "{\"token\":\"$NOTE\"}" >/dev/null 2>&1 \
  && pass "alice published a note to carol" || fail "publish to carol failed"
BATCH=""
for _ in $(seq 1 30); do
  BATCH="$(AGENT_MESH_ID=carol cli receive --generation "$GEN" 2>/dev/null || true)"
  grep -q "$NOTE" <<<"$BATCH" && break
  sleep 0.2
done
grep -q "$NOTE" <<<"$BATCH" && pass "carol received the batch ($NOTE)" || fail "carol's batch never contained the note"
BATCH_TOKEN="$(json batch.token <<<"$BATCH" || true)"
AGENT_MESH_ID=carol cli receipt --generation "$GEN" --token "$BATCH_TOKEN" >/dev/null 2>&1 \
  && pass "carol acknowledged the batch" || fail "receipt failed"
[[ "$(AGENT_MESH_ID=carol cli delivery 2>/dev/null | json receiptConfirmed)" == "true" ]] \
  && pass "delivery status shows the receipt" || fail "receipt not recorded"

# --- verdict -----------------------------------------------------------------
echo
echo "$(printf '=%.0s' {1..48})"
if [[ "$FAIL" -eq 0 ]]; then
  echo "✅ VERIFY PASSED — $PASS checks, mesh round-trip proven end to end"
  exit 0
fi
echo "❌ VERIFY FAILED — $FAIL of $((PASS + FAIL)) checks failed"
exit 1
