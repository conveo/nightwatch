# Managed mesh delivery contract

This document describes how managed delivery works on one host: how the daemon
chooses a wake-up transport for an agent, notifies it, and records its receipt.
Deployment is covered in [DEPLOY.md](DEPLOY.md). The older `inbox` and `watch`
commands keep working next to managed delivery. The skills in this repo register
with `--deliver auto`.

## Capability boundary

| Runtime / manager | Implemented behavior | Verification |
| --- | --- | --- |
| Claude / Herdr 0.8.2 | Dedicated-pane adapter, native session + foreground PID/start check; idle submit, working/blocked defer | Mock subprocess and daemon tests; real model receipt unverified |
| Codex / Herdr 0.8.2 | Same adapter, no revival | Mock subprocess and daemon tests; real model receipt unverified |
| Claude / Superset 1.26.0 | Dedicated terminal; native binding + OS owner + idle composer check | Local receipt, clock-only ticks, burst/restart, draft/dialog preservation and owner replacement |
| Codex / Superset 1.26.0 | Same checks; recognized empty composer required | Local receipt/ticks/burst/restart/draft/dialog/exit plus cross-host reply |
| Bare Claude/Codex | Explicit Monitor declaration or polling-only | Selection/identity tests; no native-app wakeup capability |

The Superset live test used two disposable local sessions and a separate daemon and
Redis. See [the verification record](VERIFICATION.md) for exact scope,
native-session receipts, and remaining gaps. Herdr has not been tested live.
Both adapters require explicit `--dedicated` and per-session receipt
proof. Working agents defer delivery until idle; this is not live steering.

Installed Herdr API schema exposes `AgentInfo.agent_session` (`kind=id`, `value`),
`pane_id`, `terminal_id`, readiness and lifecycle state; `pane process-info`
exposes foreground PIDs. Its CLI `agent prompt` rejects recognized blocked states.
The mesh compares native session, runtime, pane, runtime ancestor PID, and OS
process start time. Missing fields/shapes return unknown, except the readiness
pair `interactive_ready` / `launch_pending`: `agent get` omits both although the
schema declares them, so they default to ready and not-launching rather than
failing verification. No focused-pane lookup.
The socket path and pane are explicit. CLI commands use argv/env objects, never
shell interpolation. Output is bounded to 64 KiB, stderr to 8 KiB, and neither is
logged verbatim. Probes time out after 5 seconds each; submission after 10 seconds.

Superset auto-selection requires actual `SUPERSET_WORKSPACE_ID` and
`SUPERSET_TERMINAL_ID` launch markers. `superset status --json` resolves the local
host and organization. The daemon reads that organization's local
`~/.superset/host/<organization>/manifest.json` and queries the authenticated
loopback `terminalAgents.listByWorkspace` host API. The token stays in memory,
is never persisted by mesh, and is never sent to remote URLs or redirects.
Missing/changed metadata fails closed; the CLI must work in the daemon's environment.
This read-only API complements CLI submission and does not require MCP.

The probe compares the native session, runtime, OS PID/start time, inherited
terminal/workspace, and foreground process group. It requires a `Stop` lifecycle
event and a recognized empty composer from `superset terminals read`. It then
rechecks native/PID ownership and lifecycle before `superset terminals send`.
Claude launches must set `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`; otherwise
selection reports `prompt-suggestions-enabled`. Its generated suggestions look
like drafts in plain text. This is a per-runtime launch setting, not a global
config change. [Claude environment reference](https://code.claude.com/docs/en/env-vars).

`Start` defers as busy, permission events/dialogs as blocked, and visible drafts
as `draft-present`. Unknown events, process inspection, or screen layouts defer.

Supported composer layouts are Claude's empty `❯` between horizontal rules and
Codex's empty `›` or `Ask Codex to do anything`, followed by its status footer.
Codex's `Worked for …` and `Conversation recap` separators are supported. Text snapshots cannot distinguish
a human draft identical to a placeholder. Dedicated terminals therefore exclude
human edits and competing input senders. New runtime layouts require verification
and parser tests rather than automatic submission. Process inspection supports
macOS and Linux; live proof currently covers macOS only.

References: [Superset CLI](https://docs.superset.sh/cli/cli-reference),
[Herdr automation](https://herdr.dev/docs/agent-automation/),
[Herdr socket API](https://herdr.dev/docs/socket-api/),
[Herdr integrations](https://herdr.dev/docs/integrations/). Installed help/schema
are the version-specific basis; future documentation is not a flag contract.

## CLI

All commands accept `--id <actor>` where identity is needed. The installed wrapper
pins caller cwd. Explicit actor IDs win; native derivation preserves existing
Claude names and adds Codex `CODEX_THREAD_ID`. An explicit native session can be
supplied through `--native-session` on `whoami`, `register`, or `rebind`, or through
`AGENT_MESH_NATIVE_SESSION`. Pin `AGENT_MESH_ID` for later turns. Human `cli.env`
fallback is skipped for either runtime, manager terminal/pane markers, or an explicit
native-session flag. If Claude exports no native ID, the CLI resolves it from
the verified local Superset binding and owning runtime ancestor. It never derives
a native session ID from a terminal ID.

```bash
agent-mesh register --role implementer --deliver auto
agent-mesh register --role orchestrator --deliver auto --dedicated --tick 15
agent-mesh register --role reviewer --deliver auto --binding /absolute/herdr.json --dedicated
agent-mesh register --role planner --deliver auto --monitor
agent-mesh delivery
agent-mesh receive --generation <uuid>
agent-mesh receipt --generation <uuid> --token <batch-uuid>
agent-mesh rebind --role reviewer --generation <old-uuid> --binding /absolute/herdr.json --dedicated
agent-mesh retry --generation <uuid> --token <batch-uuid>
agent-mesh retire --generation <uuid>
```

These are alternatives, not a sequence of registrations for the same actor.
`register --deliver auto` creates a binding once; use `rebind` intentionally after
inspection. `--runtime claude|codex` disambiguates nested runtime environments.
`--meta scope=run,ticket=PROJ-123` carries public workflow metadata (one comma-separated
flag); keep bindings and credentials out of it. Rebind callers supply any metadata
they want carried forward. Registration finds the actual runtime ancestor rather than accepting an arbitrary
PID flag. If the harness has no accessible runtime ancestor, the adapter cannot
verify ownership; explicit session metadata alone does not authorize delivery.

Binding JSON contains **only** the manager address (kept local, never committed):

```json
{"type":"herdr","socket":"/absolute/herdr.sock","pane":"w1:p1"}
```

```json
{"type":"superset","host":"host-id","workspace":"workspace-id","terminal":"terminal-launch-sessionId"}
```

No credential belongs in a binding. CLI authentication remains in the manager's own environment/config.
`--dedicated` asserts exclusive agent ownership: no human drafts, pane sharing,
or reuse/restoration while the binding is live. It does not bypass verification.

Selection is centralized in `managed-delivery.ts`: explicit verified binding;
otherwise demonstrable Superset/Herdr ownership; ambiguous nested hints return
`address-ambiguous`. A stale/missing endpoint is `unconfigured`, inaccessible
backend `unavailable`, changed native/PID owner `owner-changed`, absent supported
primitive `unsupported`. Configured failures never silently fall back. With no
manager hint, `--monitor` selects Monitor; otherwise polling-only. The CLI cannot
infer harness tool availability. Monitor status uses `automaticWakeup=null`
because only the harness can attest its wakeups; the CLI gate attests adapters only. No binary-presence priority exists.

## Inbox, notification, receipt, completion

Redis ingestion first fsyncs the local inbox, then advances its cursor. Failed
storage leaves the cursor retryable; replay deduplicates by message channel+ID,
including each fan-out recipient. A failure in one fan-out can temporarily delay
that ingestion batch while preserving already-written recipients. Other manager
subprocesses never block Redis ingestion.

Each adapter actor has a separate persisted pending batch, at most 100 messages,
plus at most one overdue tick. The fixed notification carries actor, generation,
and batch token, never the work-order body or arbitrary runnable command text.
At most four recipient pipelines execute per daemon and one per actor. Once a
batch exists it remains immutable through retries/receipt, so later arrivals form
a new batch after the first is accepted. Every message retains its body, order,
sender, channel, correlation ID, and reply relationship.

`receive` returns the outstanding batch without consuming it. The **agent** must
read the output and then call `receipt` with that generation/token. It must not
ACK in a shell pipeline or use a setup helper to ACK unseen comments. Duplicate
ACK of the most recently received token is idempotent; stale generations/tokens
are rejected. A receipt advances only the bounded managed cursor. Late messages
cannot be hidden by an earlier receipt.

States distinguish `pending`, persisted send intent (`sending`), CLI success
(`submitted`), uncertain outcome (`ambiguous`), and exhausted/rejected attempts
(`exhausted` plus reason). Definite non-delivery retries with capped exponential
backoff, up to eight attempts; blocked/unknown probes also exhaust visibly.
Busy owners are checked every 15 seconds without consuming the failure budget,
so a long-running turn can still receive its pending batch when it becomes idle.
A submitted batch awaits receipt without automatic replay. Timeouts and crashes
while sending remain ambiguous across restart. `retry` explicitly re-arms that
batch **after inspection** establishes another notification is appropriate; never
infer permission to repeat work from a timeout. Missing receipts remain visible.

This targets at-least-once notifications where non-delivery is known and duplicate
wakeups can be deduplicated. It does not guarantee unattended delivery through
ambiguous outcomes, exactly-once execution, or task recovery after receipt.
Receipt means received/accepted, not completed. Preserve work outcomes through
`status`/`blocker`/`result`. Review work must deduplicate by channel+ID and any
application comment identity; receipt is not a separate task ledger.

Legacy `inbox` consumes its independent read cursor; `inbox --peek` does not.
Legacy watch peeks and ACKs its own cursor after stdout flush. Managed receipt
never changes either legacy cursor. Adapter/polling bindings reject watch and SSE
push so a second consumer cannot be armed accidentally. Monitor watch callbacks
carry a generation; old callbacks are rejected. Already-queued harness events
cannot be recalled, so Monitor-to-adapter migration requires a new actor ID.

## Persistence and ownership

`local-agents.json` stores selected managed transport, generation, native owner,
and tick interval. `wakeups.json` stores bounded pending range/token, receipt
cursor, attempts/outcome, and next/due tick. `state.json` retains broker/read/watch
cursors; inbox JSONL remains the message source. JSON writes use file fsync,
atomic rename, and directory fsync; inbox appends fsync before cursor advancement.
Malformed persistence fails visibly instead of being replaced with empty state.
Reads preserve complete messages and report an incomplete trailing JSONL record
without modifying the file. The next broker replay truncates only that incomplete
tail, appends the pending message, and fsyncs the file and directory before cursor
advancement. A valid final record missing its newline is preserved and terminated.
Malformed newline-terminated records still fail visibly and require operator repair;
there is no general corruption skipping or disk-full bypass.

The daemon caches parsed inbox messages and a channel+ID set, avoiding repeated
full-history scans on append and polling. File identity, length, and nanosecond
modification/change timestamps invalidate cached data after edits or replacement;
restart rebuilds it from JSONL. At most 64 actor snapshots are retained. This does
not compact mail: disk history and each retained snapshot still grow with history,
so retention/archiving remains an explicit operator responsibility.

Clean daemon exit kills active manager subprocesses. An abrupt SIGKILL can leave
an orphan CLI; sending intent restores as ambiguous, and rebind/retire refuse that
unresolved batch. Inspect any orphan and obtain/accept the work before an explicit
rebind. This is another reason an ambiguous send is not an automatic retry signal.

A Redis owner key holds the generation without expiry. Initial claim/rebind uses
compare-and-set; startup, ingestion, submission, and heartbeat check ownership.
An updated daemon cannot silently adopt another host's actor, downgrade a binding
through old `register`, or overwrite it from stale persistence. Rebind is
serialized and rejected during submission. It preserves unread history but resets
pending notification/receipt proof into a new generation. Duplicate local endpoint
bindings are rejected. One manager endpoint must belong to one actor across the
host's daemons/brokers; automatic multi-broker relay delivery is not supported.

Cross-host same-ID transfer is intentionally refused. Use a new actor ID and
explicit publisher handoff, preserve old mail, and verify out-of-band continuity.
Retirement places a tombstone in the owner key, cancels ticks/pending delivery,
keeps inboxes/cursors, and removes local serving state. It never frees the ID for
silent reuse. Legacy unregister retains its historical destructive behavior.
Do not run old daemon versions alongside new owners: older binaries do not know
these owner keys. A failed bind between broker claim and local persistence can
leave a reserved actor requiring operator reconciliation; no TTL steals it.

The socket and broker remain trusted host infrastructure, not authentication
boundaries. UUIDs fence stale callbacks; they are not secrets or identity proofs.

## Clock, liveness, and recovery

`--tick <minutes>` on an adapter binding persists next due time. With no worker
traffic, the daemon includes a tick in the same notification/receipt path. After
sleep/restart, one overdue tick is retained, not a flood. Receipt clears that due
tick; retirement cancels the schedule. Monitor mode instead uses `watch --tick`;
no daemon timer is armed for that actor. A surviving watch retries daemon failures
with backoff; only a dead watcher/harness needs re-arming.

Managed owner liveness is exposed by current target verification and delivery
failure, not the Claude transcript sweep. Codex is never probed as Claude. A
missing/unknown manager result is not declared dead. The roster's heartbeat is
not model readiness. Mesh has no managed revival; keep processes alive. The legacy
`claude-resume` transport is separate. It resumes only a dormant Claude session and
skips the resume while the session's process is still alive, so it never forks a
live session.

Both adapters' preflight and submission are **not atomic**. A replacement, new
dialog, or draft can appear between checks and the write. Superset checks again
after its screen read, but neither backend provides an expected-owner/draft-aware
atomic submission primitive here. Restrict support to dedicated stable terminals
with no competing input. Replacements/moves/restores require deliberate rebind
and fresh receipt proof. Shared terminals remain unsupported. Hook lifecycle and
screen detection are fallible; no perfect dialog or occupant fencing is claimed.

## Reviews and readiness

Plan-review and human-review publishers address agents by mesh ID and keep the full
context in the message body. They do not know manager addresses. The reviewer
overlay does not show delivery status. Run the review tool in its own terminal, with
an explicit working directory, the reviewing agent's ID and its own broker
environment; it keeps running after the reviewer agent's setup ends.

`delivery` is local read-only inspection: transport, current verification,
generation, pending/received counts, error outcome/reason, and tick proof.
`preflight.sh` requires current idle verification, a receipt within five minutes,
and (by default) a received tick. Use `MESH_REQUIRE_TICK=0` only for a non-orchestrator.
It does not replace live checks: a real receive and reply, a cross-host message,
spawning, permissions and authentication, and the review publishers.

The automated tests start their own daemons and use a separate Redis key prefix, so
they do not touch a running daemon. When you upgrade the daemon on a host, keep its persisted state, and check
that the daemon's environment can run the manager CLI and read its local metadata.
Bind or rebind dedicated sessions on purpose, and prove receipt and ticks before you
leave a run unattended.
