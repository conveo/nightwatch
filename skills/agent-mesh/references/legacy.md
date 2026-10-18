# Legacy Monitor and revival

Only use Monitor when the actual harness exposes its event-injection tool. On a
new auto registration, pass `--monitor`; it is a declaration of tool capability,
not environment detection. A detected but broken manager still produces an
unavailable result, so choose a fresh bare session if Monitor fallback is needed.
Existing `sse` registrations remain compatible without conversion.

Run exactly one `agent-mesh watch --id <id>` under the harness Monitor. For an
orchestrator use `--tick 15`. `MSG` lines wake the receiving turn; `TICK` lines
trigger supervision. Watch peeks, emits, then ACKs its independent cursor. It
never consumes the legacy inbox. Read and act on messages in the receiving turn.

A running watch retries daemon socket failures with backoff and preserves its
cursor across daemon restarts. Re-arm only if the watch or its harness dies, and
stop the old watcher first. A new generation stops an old generation's watch.
Queued events already in the harness cannot be recalled; switching from Monitor
to adapters requires a new actor ID and explicit publisher handoff.

`register --deliver claude-resume:<native-session>` remains a legacy **revival**
transport. It captures cwd/PID, checks for a live Claude owner, debounces, and
skips revival while live. It does not deliver into an idle running process and
cannot be proved while that process is alive. There is no Codex revival transport
and no automatic adapter-to-resume fallback.

Legacy `fifo`, `file`, `exec`, `sse`, and `none` syntax remains accepted. `exec` is
best-effort detached delivery, not a reliable managed adapter. Do not route new
manager integrations through shell command strings.
