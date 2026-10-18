# Superset delivery verification

This is the record of one live verification of managed delivery into Superset
terminals. It supplements the [delivery contract](DELIVERY.md). Every session you
deploy still needs its own receipt and readiness check.

Setup: Superset CLI 1.26.0, Claude Code 2.1.263 and Codex CLI 0.153.4 on macOS,
isolated mesh daemons, and a disposable Redis. A Linux host took part only as the
remote publisher in the cross-host test.

## Results

| Check | Claude + Superset | Codex + Superset |
| --- | --- | --- |
| Native session and runtime PID matched to the terminal | Passed, including native-id lookup when the environment omitted it | Passed with `CODEX_THREAD_ID` |
| An idle CLI prompt reaches the existing model | Passed; the receiver wrote a unique receipt file | Passed; the receiver wrote a unique receipt file |
| Daemon notification, non-consuming receive, explicit receipt, result | Passed | Passed |
| Clock-only tick with no worker message | Passed | Passed |
| A busy turn holds later work until the session is idle | Passed | Passed |
| A five-message review burst keeps order, correlation ids, reply links, quotes, newlines and screenshot keys | Passed | Passed |
| A pending burst survives a daemon restart | Passed | Passed |
| An unsent draft stays untouched; the wake-up stays pending | Passed | Passed |
| A recognized dialog prevents submission | An unanswered `AskUserQuestion`; the message stayed pending | An open `/permissions` menu; the message stayed pending, no option selected |
| An exited owner cannot receive; unread mail is kept on retirement | Passed | Passed |
| A new owner or generation receives the kept mail | Passed with a replacement Claude process | Automated ownership tests only |
| The clock schedule survives a daemon restart | Passed with a replacement Claude process | Automated timer tests only |
| Real cross-host round trip | Not repeated | Remote publisher, laptop daemon, native Codex session, reply in the remote inbox: passed |

Not covered by this run:

- Herdr. Its Claude and Codex adapters have automated subprocess and isolated-daemon
  tests only; no Herdr agent was launched.
- Linux as the receiving host for managed delivery.
- Other runtime versions and screen layouts.
- Browser-driven plan-review or human-review publishers. The review tests used
  representative mesh payloads.

## Findings from the run

- Terminal ids are Superset launch addresses, not native conversation ids. The mesh
  never derives one from the other.
- Claude can show a generated next-prompt suggestion where a human draft would
  appear, and the text snapshot cannot tell them apart. The adapter therefore
  requires `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` in the Claude launch
  environment. This is a per-launch setting, not a global configuration change.
- Codex uses different separators after long turns and after a conversation recap.
  Both observed layouts have parser regression tests. Its permissions menu is
  classified as blocked. Unknown layouts defer.
- Read the full terminal viewport. Looking only at the bottom rows can miss the
  composer right after the terminal is resized.
- The native binding and lifecycle come from Superset's authenticated local host
  API; submission is `superset terminals send`. The code bounds output, rejects
  non-loopback metadata URLs and redirects, and keeps the host token out of
  bindings, Redis and logs.

## Limits

- Preflight and submission are not atomic. A dialog, draft or replacement can
  appear after the last check. Use dedicated terminals with no other human or
  program typing into them.
- A typed Codex draft that equals its placeholder text cannot be told apart from an
  empty composer.
- No permission dialog was answered, no draft was cleared to force delivery, and no
  running agent was resumed in a second process during the run.
