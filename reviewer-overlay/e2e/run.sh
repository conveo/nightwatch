#!/usr/bin/env bash
# End-to-end check: a throwaway Redis, an agent-mesh daemon on it, a listener
# agent, the review server, the demo page, and a headless Chrome driven by
# agent-browser. It drops a pin, types a note, sends it, and asserts that the
# listener received a `ui-review` note with that text and a PNG screenshot.
#
#   bash reviewer-overlay/e2e/run.sh
#
# AGENT_MESH_DIR  agent-mesh package directory with its dependencies installed
#                 (default: this repo's agent-mesh/)
# CHROME          Chrome or Chromium binary (default: agent-browser's download)
# CHROME_FLAGS    extra flags, e.g. "--no-sandbox" where Chrome's sandbox cannot start
# KEEP_WORK=1     keep the work directory for inspection
#
# Chrome is started here, not by agent-browser, because tab capture in headless
# mode needs --auto-accept-this-tab-capture and agent-browser drops that flag.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_MESH_DIR="${AGENT_MESH_DIR:-$ROOT/../agent-mesh}"
[[ -f "$AGENT_MESH_DIR/src/cli.ts" ]] || { echo "AGENT_MESH_DIR=$AGENT_MESH_DIR is not an agent-mesh package directory" >&2; exit 1; }
AGENT_MESH_DIR="$(cd "$AGENT_MESH_DIR" && pwd)"
RUN_ID="$(date +%s)-$$"
WORK="$ROOT/.e2e/$RUN_ID"
mkdir -p "$WORK"
REDIS_NAME="reviewer-overlay-e2e-$RUN_ID"
SESSION="reviewer-overlay-e2e-$RUN_ID"
LISTENER_ID="e2e-listener"
NOTE_TEXT="The save button label is cut off: it reads SAVE ALL WORKSP..."
PIDS=()

log() { printf '\n[e2e] %s\n' "$*"; }

free_port() {
  node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

cleanup() {
  local status=$?
  set +e
  agent-browser --session "$SESSION" --cdp "${CDP_PORT:-0}" close >/dev/null 2>&1
  # Each background job leads its own process group (setsid), so killing the
  # group also stops the node children that pnpm and Chrome start.
  for pid in "${PIDS[@]}"; do
    kill -- "-$pid" 2>/dev/null
  done
  sleep 0.5
  for pid in "${PIDS[@]}"; do
    kill -9 -- "-$pid" 2>/dev/null
  done
  docker rm -f "$REDIS_NAME" >/dev/null 2>&1
  if [[ "${KEEP_WORK:-}" != "1" ]]; then
    rm -rf "$WORK"
    rmdir "$ROOT/.e2e" 2>/dev/null
  else
    echo "[e2e] work directory kept: $WORK"
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ -z "${CHROME:-}" ]]; then
  CHROME="$(ls -1d "$HOME"/.agent-browser/browsers/chrome-*/chrome 2>/dev/null | tail -1 || true)"
fi
[[ -x "${CHROME:-}" ]] || { echo "set CHROME to a Chrome binary" >&2; exit 1; }

REDIS_PORT="$(free_port)"
SERVER_PORT="$(free_port)"
DEMO_PORT="$(free_port)"
CDP_PORT="$(free_port)"

# Every mesh process gets a minimal environment, so ids, sockets and session
# variables from the calling shell cannot leak into the test mesh.
MESH_ENV=(
  env -i
  "PATH=$PATH"
  "HOME=$HOME"
  "AGENT_MESH_REDIS_URL=redis://127.0.0.1:$REDIS_PORT"
  "AGENT_MESH_HOME=$WORK/mesh-home"
  "AGENT_MESH_PREFIX=e2e$RUN_ID"
  "AGENT_MESH_HOSTNAME=e2e-host"
)
mesh() { "${MESH_ENV[@]}" pnpm --silent --dir "$AGENT_MESH_DIR" exec tsx src/cli.ts "$@"; }
# --cdp on every call: without it agent-browser starts its own browser.
ab() { agent-browser --session "$SESSION" --cdp "$CDP_PORT" "$@"; }

log "building the client bundle"
(cd "$ROOT" && node scripts/build-client.ts)

log "starting Redis ($REDIS_NAME on 127.0.0.1:$REDIS_PORT)"
docker run -d --name "$REDIS_NAME" -p "127.0.0.1:$REDIS_PORT:6379" redis:7-alpine >/dev/null
for _ in $(seq 1 50); do
  docker exec "$REDIS_NAME" redis-cli ping 2>/dev/null | grep -q PONG && break
  sleep 0.2
done

log "starting the agent-mesh daemon"
setsid "${MESH_ENV[@]}" pnpm --dir "$AGENT_MESH_DIR" daemon >"$WORK/daemon.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 100); do
  mesh health >/dev/null 2>&1 && break
  sleep 0.2
done
mesh health >/dev/null

log "registering the listener ($LISTENER_ID) and watching its inbox"
mesh register --id "$LISTENER_ID" --role reviewer --deliver none
setsid "${MESH_ENV[@]}" pnpm --silent --dir "$AGENT_MESH_DIR" exec tsx src/cli.ts watch --id "$LISTENER_ID" \
  >"$WORK/listener.out" 2>"$WORK/listener.err" &
PIDS+=($!)

log "starting the review server on 127.0.0.1:$SERVER_PORT"
setsid "${MESH_ENV[@]}" node "$ROOT/src/server/main.ts" \
  --port "$SERVER_PORT" \
  --origin "http://127.0.0.1:$DEMO_PORT" \
  --target "$LISTENER_ID" \
  --plan "$ROOT/demo/review-plan.json" \
  --report-dir "$WORK/reports" \
  --mesh-cli "[\"pnpm\",\"--silent\",\"--dir\",\"$AGENT_MESH_DIR\",\"exec\",\"tsx\",\"src/cli.ts\"]" \
  >"$WORK/server.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$SERVER_PORT/api/review" >/dev/null 2>&1 && break
  sleep 0.2
done

log "serving the demo page on 127.0.0.1:$DEMO_PORT"
mkdir -p "$WORK/demo"
sed "s#http://127.0.0.1:4848/#http://127.0.0.1:$SERVER_PORT/#" "$ROOT/demo/index.html" >"$WORK/demo/index.html"
setsid python3 -m http.server "$DEMO_PORT" --bind 127.0.0.1 --directory "$WORK/demo" >"$WORK/demo.log" 2>&1 &
PIDS+=($!)

log "starting headless Chrome (CDP on $CDP_PORT)"
# shellcheck disable=SC2086
setsid "$CHROME" --headless=new ${CHROME_FLAGS:-} --remote-debugging-port="$CDP_PORT" --user-data-dir="$WORK/chrome" \
  --auto-accept-this-tab-capture --window-size=1280,800 --no-first-run --no-default-browser-check about:blank \
  >"$WORK/chrome.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.2
done

# Center of an element inside the overlay's shadow root, as "x y".
shadow_center() {
  ab eval "(() => { const el = document.querySelector('reviewer-overlay').shadowRoot.querySelector('$1'); const r = el.getBoundingClientRect(); return Math.round(r.left + r.width / 2) + ' ' + Math.round(r.top + r.height / 2) })()" | tr -d '"'
}
page_center() {
  ab eval "(() => { const r = document.querySelector('$1').getBoundingClientRect(); return Math.round(r.left + 24) + ' ' + Math.round(r.top + r.height / 2) })()" | tr -d '"'
}
# Real mouse input: tab sharing needs a trusted user gesture.
click_at() {
  ab mouse move "$1" "$2" >/dev/null
  ab mouse down >/dev/null
  ab mouse up >/dev/null
}
# innerText skips hidden elements, so this waits for text the reviewer can see.
wait_shadow_text() {
  ab wait --fn "document.querySelector('reviewer-overlay')?.shadowRoot?.querySelector('.root')?.innerText.includes('$1') === true" >/dev/null
}

log "driving the demo page with agent-browser"
ab open "http://127.0.0.1:$DEMO_PORT/" >/dev/null
ab wait --fn "document.querySelector('reviewer-overlay')?.shadowRoot?.querySelector('.bubble') != null" >/dev/null

# shellcheck disable=SC2046
click_at $(shadow_center ".bubble")
wait_shadow_text "Save button label"
echo "  panel open, plan loaded"

# shellcheck disable=SC2046
click_at $(shadow_center ".step input[type=checkbox]")
wait_shadow_text "1 of 3 steps checked"
echo "  first step checked"

# shellcheck disable=SC2046
click_at $(shadow_center ".panel-foot .btn.primary")
wait_shadow_text "Click the page to drop a pin"
sleep 1
echo "  comment mode on"

# shellcheck disable=SC2046
read -r PIN_X PIN_Y <<<"$(page_center "#save")"
click_at "$PIN_X" "$PIN_Y"
wait_shadow_text "Pin #1"
echo "  pin dropped at $PIN_X,$PIN_Y"

# shellcheck disable=SC2046
click_at $(shadow_center ".composer textarea")
ab keyboard type "$NOTE_TEXT" >/dev/null
ab screenshot "$WORK/before-send.png" >/dev/null

# shellcheck disable=SC2046
click_at $(shadow_center ".composer .btn.primary")
ab wait --fn "/Sent to |Not delivered|Cannot reach/.test(document.querySelector('reviewer-overlay').shadowRoot.querySelector('.root').innerText)" >/dev/null
STATUS="$(ab eval "document.querySelector('reviewer-overlay').shadowRoot.querySelector('.toolbar .status').textContent" | tr -d '"')"
echo "  overlay status: $STATUS"
ab screenshot "$WORK/after-send.png" >/dev/null
[[ "$STATUS" == Sent\ to\ "$LISTENER_ID"\ with\ a\ screenshot* ]] || { echo "send failed"; cat "$WORK/server.log"; exit 1; }

log "waiting for the listener to receive the note"
for _ in $(seq 1 50); do
  grep -q '"correlationId":"ui-review"' "$WORK/listener.out" 2>/dev/null && break
  sleep 0.2
done
MSG_LINE="$(grep -m1 '"correlationId":"ui-review"' "$WORK/listener.out" || true)"
[[ -n "$MSG_LINE" ]] || { echo "listener got nothing"; cat "$WORK/listener.err"; exit 1; }

node - "$MSG_LINE" "$NOTE_TEXT" "$LISTENER_ID" <<'EOF'
const fs = require("node:fs")
const [line, noteText, listener] = process.argv.slice(2)
const message = JSON.parse(line.replace(/^MSG /, ""))
const fail = (why) => { console.error(`[e2e] FAIL: ${why}`); process.exit(1) }
if (message.type !== "note") fail(`type ${message.type}`)
if (message.correlationId !== "ui-review") fail(`correlationId ${message.correlationId}`)
if (message.to !== listener) fail(`to ${message.to}`)
const body = message.body
if (body.kind !== "ui-review-comment") fail(`kind ${body.kind}`)
if (body.comment !== noteText) fail(`comment ${JSON.stringify(body.comment)}`)
if (body.pin?.n !== 1) fail("pin missing")
const png = fs.readFileSync(body.screenshot)
if (png.subarray(1, 4).toString("latin1") !== "PNG") fail("screenshot is not a PNG")
const shown = { ...message, body: { ...body, note: `${body.note.slice(0, 80)}...` } }
console.log("[e2e] listener received:")
console.log(JSON.stringify(shown, null, 2))
console.log(`[e2e] screenshot: ${body.screenshot} (${png.length} bytes, ${png.readUInt32BE(16)}x${png.readUInt32BE(20)})`)
console.log("[e2e] PASS")
EOF

if [[ -n "${E2E_ARTIFACTS:-}" ]]; then
  mkdir -p "$E2E_ARTIFACTS"
  cp "$WORK"/before-send.png "$WORK"/after-send.png "$E2E_ARTIFACTS"/
  cp "$WORK"/reports/*.png "$E2E_ARTIFACTS"/received-screenshot.png
  printf '%s\n' "$MSG_LINE" >"$E2E_ARTIFACTS/listener-message.txt"
fi
