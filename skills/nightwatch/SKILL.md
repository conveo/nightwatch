---
name: nightwatch
description: Plan and run an overnight multi-agent engineering fleet that turns an afternoon of planning into a morning-ready master PR + test plan. Use when you want to orchestrate parallel agents — Claude Code or Codex CLI across a laptop + a remote box over the agent mesh, or Devin child sessions from a single Devin orchestrator with GitHub as the only shared state — shaping work into tickets, gating every PR, consolidating into one master PR, and handing the Captain a test plan in the morning. Auto-detects the backend (Devin-only vs mesh + Superset/Herdr). Covers the pre-sleep checkpoints and the end-of-run cleanup. The single entry point; defers to the agent-mesh, plan-review, and human-review skills for the mesh mechanics, and to references/devin.md / references/superset.md / references/herdr.md for backend-specific commands.
---

# nightwatch: the afternoon → morning loop

A person (**Captain**) plans in the afternoon with a laptop-side agent (**the
Helm**). The Helm shapes the work into tickets and constraints and starts a
persistent **remote orchestrator** (the "field orchestrator") on a large remote
box, through Superset or a Herdr-managed session, whichever already reaches that
box. The two orchestrators are **co-equal** and coordinate over the **agent mesh**.
The remote orchestrator orders the build, starts worker agents overnight, and gates
every PR. By morning there is a reviewed, gate-passed **master PR**, a step-by-step
**test plan**, and, once the Captain comes online, a **reviewer** agent on their
laptop so their feedback reaches the fleet over the mesh.

`NIGHTWATCH_HOME` below is the clone of the nightwatch repository (the directory
that contains `agent-mesh/` and `skills/`). The `agent-mesh` command must be on
`PATH`; see the `agent-mesh` skill.

This skill is the playbook. It defers to three other skills for mechanics:

- **`agent-mesh`**: the CLI, identity rules, receive/receipt, ticks,
  blocker → decision, host addressing, liveness.
- **`plan-review`**: the Phase 1 plan-refinement loop in the dashboard's Plans tab.
- **`human-review`**: the Phase 7 review loop, the test-plan schema and the
  `ui-review` message contract.

And to three backend references in this skill. Read the one that matches your run
before Phase 3 (Devin-only: before Phase 1):

- **[`references/devin.md`](references/devin.md)**: **Devin-only mode**. No mesh,
  no Redis, no Superset or Herdr. One Devin session orchestrates, workers are Devin
  child sessions, GitHub is the durable state. It replaces Phases 2, 3, 4, 7 and 8;
  the other phases apply with the changes noted there.
- **[`references/superset.md`](references/superset.md)**: Superset CLI commands per
  phase.
- **[`references/herdr.md`](references/herdr.md)**: Herdr commands per phase.

## The four capabilities this needs

nightwatch needs four things. Anything that provides them works.

| Capability | What it does | Used here |
| --- | --- | --- |
| **Spawner** | Starts an agent in a fresh worktree on a named branch, on a chosen host | Superset CLI or Herdr; also plain `git worktree` + tmux, or SSH + the agent CLI |
| **Durable bus** | Ordered, replayable messages addressed by agent id, across hosts | `agent-mesh` (Redis Streams) |
| **Validation agents** | Let a worker prove its own PR is merge-ready before it stops | Your CI and the review bots you run on PRs |
| **Wake a running agent** | Deliver a message into an idle agent's session so it acts now | Mesh delivery into a dedicated Superset terminal or Herdr pane, or Claude Code's Monitor |

## Choosing a backend: Devin-only vs Superset vs Herdr

**Detect the mode first, before you write any planning artefact**, and record it
as the first line of the orchestrator log:

1. **Devin-only**: you are running as a Devin session (the built-in
   `devin_session_create` / `devin_session_interact` / `devin_session_search`
   tools exist and `$DEVIN_DIR` is set). Follow `references/devin.md`. Everything
   below about the mesh, panes, Superset and Herdr does not apply to you.
2. **Mesh**: you are a Claude Code or Codex session, a mesh broker is reachable
   (`AGENT_MESH_REDIS_URL` set and `agent-mesh` on `PATH`), and a Superset host or a
   Herdr daemon is available. Continue with this section to pick Superset or Herdr.
3. **Neither**: a Claude Code or Codex session with no reachable mesh, Superset or
   Herdr. Devin-only is not a fallback (it needs the Devin child-session tools).
   Report a launch blocker and stop.

A Devin orchestrator always takes mode 1, even when a mesh is reachable: it has no
pane for verified delivery and would be polling-only, which fails the
unattended-readiness rule below.

Choose three things independently: the orchestration manager, the receiving
session's mesh delivery binding, and host provisioning. Claude Code or Codex can
fill any agent role when its actual tools, delivery and recovery meet that role's
needs.

Superset CLI is the preferred cross-host control surface (`--host`); its MCP server
is an optional alternative. Herdr commands target an explicit local socket; the
daemon need not occupy a pane. Reach another host over authorized SSH, or ask its
mesh agent to act locally. `HERDR_ENV` and installed binaries are hints, not proof
of ownership.

Follow the common `agent-mesh` detection and receipt verification. Superset and
Herdr delivery require a dedicated terminal or pane and a verified native owner;
starting an agent does not prove that mesh wake-ups reach it. Busy, blocked, draft
and unknown states defer. Prove receipt and daemon ticks for each intended session.
A bare session needs an actual Monitor or stays polling-only. A polling-only Helm,
orchestrator or reviewer cannot pass unattended readiness.

A Superset-provisioned host can still run Herdr and use the same broker. Do not
infer provisioning or delivery from the manager choice.

## The roles (co-authority is the keystone)

- **Captain (person):** sets the goal, makes the calls (scope, merge, announce),
  runs the morning test.
- **The Helm (laptop orchestrator):** the Captain's planning partner. Turns a
  conversation into a plan, starts the remote orchestrator, holds **co-authority**
  over the fleet, and stays reachable while the Captain sleeps. Keep managed
  processes alive: the mesh does not revive Codex sessions.
- **The field orchestrator (remote):** persistent; **plans its own build order**
  within the Helm's constraints; starts and supervises workers; gates every PR;
  runs overnight. **Co-equal** to the Helm.
- **Workers:** one ticket each, one worktree each, **execute in the receiving
  turn**, push first, gate to merge-ready. They listen to **both** orchestrators
  equally, which is what lets the Helm sleep without stalling the fleet.

In Devin-only mode the Helm and the field orchestrator are **one** persistent Devin
session and the workers are its child sessions. Co-authority does not apply; the
Captain talks to the orchestrator session directly.

## The anti-blocking clause: put this in every spawn prompt

Claude Code's `--dangerously-skip-permissions` and Codex's YOLO mode bypass tool
approvals, not questions the agent asks (`AskUserQuestion` or
`request_user_input`). A correctly flagged headless agent can still sit on its own
question all night. The mesh roster cannot show this: `agent-mesh agents` reports
the agent `online` because its process is alive, but blocked delivery cannot wake
it. Only reading its pane shows the dialog.

**Every orchestrator and worker prompt must carry an explicit anti-blocking
clause**, for example:

> Never stop on a clarifying question. Pick the most conservative sane default,
> write the decision and your reasoning to the orchestrator log, publish a
> `note` saying what you assumed, and continue. Only a genuine blocker justifies
> stopping, and you stop by publishing `type=blocker` over the mesh — never by
> sitting on a dialog.

Phase 5's supervision loop therefore cannot trust `online` alone; see that phase.

Devin workers fail the same way (a session parked on a question reports as
running or blocked, not finished). `references/devin.md` has the Devin wording of
the clause; use that one there.

## Phase 1 — Plan (afternoon)

Fan out read-only exploration agents to map the code. Shape the work into tickets
with **explicit dependencies and parallel lanes**, and for **every ticket** define
the cheapest closed **verification loop** the worker can run itself:

- **Functional** ("does it do the thing?"): a unit or integration test, or a
  **purpose-built script** the worker runs on demand, many times, with no person in
  the loop (for example, a script that starts one sandbox and runs one thing,
  instead of clicking through the product).
- **Non-functional** ("is it clean and safe to ship?"): the **gate** (CI plus your
  review bots).

Put both into the ticket's acceptance criteria. "Build X; verify with
`node scripts/check-x.mjs` showing Y; gate to a pass" converges much faster than
"build X". Set the **milestone bar** (what "testable" means for this run) and name
the **serialization points** (for example, one schema file means one writer at a
time). If the remote box cannot reach your issue tracker, **mirror the tickets into
a committed notes file**.

**Visual verification.** Tests, scripts and component stories are the cheap first
rung (no sign-in, no full app). Use full-app browser checks only for tickets that
already need the app running. The pattern (it needs the Phase 3 bootstrap): start
the dev server **once per box and reuse it**, sign in once and keep the session in
a persistent browser profile, open the changed route, wait for the network to go
idle, take a screenshot, and attach it to the PR. localhost is loopback on the same
box, so no tunnel is needed.

**Refine the plan with the Captain in the loop.** When the plan benefits from
review before building, especially anything with a visible result, use the
**`plan-review`** skill: write the plan as Markdown (canonical) plus an optional
HTML sibling with mockups, open it in the dashboard's **Plans tab** (one shared
server per host) with an **absolute-path link**
(`http://127.0.0.1:4747/?view=plans&plan=/abs/…&to=planner`), and let the Captain
select and comment on any text or image while you (as `planner`) edit it over the
mesh. The dashboard listens on 127.0.0.1 only and has no authentication, so it has
no option to bind a network address. When it runs on a remote box, the Captain
first opens a tunnel from the laptop (`ssh -N -L 4747:127.0.0.1:4747 <remote-host>`;
any free local port works) and then uses the same `127.0.0.1` link. The plan must
be inside the dashboard's checkout, one of its git worktrees, or a directory in
`AGENT_MESH_PLANS_ROOTS`; see the `plan-review` skill. Commit the final plan and
hand its path to the field orchestrator in Phase 3.

> **Devin-only:** there is no Plans tab. The plan review is a comment on the
> ticket plus the blocking greenlight message; the plan and tickets live in a notes
> directory on the orchestrator branch. See `references/devin.md` → Phase 1.

## Phase 2 — Register and verify delivery

> **Devin-only:** skip; replaced by the preflight checklist in
> `references/devin.md` → Phase 2.

Use the `agent-mesh` skill's shared bootstrap, detection and receipt procedure.
Prefer an already configured broker URL; on provisioned hosts it may already be
injected (a login-shell profile or an env file your provisioning writes),
whichever manager you use. Keep credentials out of prompts and command output.

Give each actor a deterministic run-scoped id (`nw-<scope>-<role>-<unique>`).
Record actor, worktree, runtime session, manager launch response and role in the
run manifest; endpoint, socket and process evidence stays on its host. Register a
fresh actor with `--deliver auto`; add `--dedicated` only for an exclusive Superset
terminal or Herdr agent pane. Add `--tick 15` for an eligible adapter orchestrator.
A Monitor orchestrator instead declares `--monitor` and runs `watch --tick 15`
through its harness.

Inspect `agent-mesh delivery`, then prove an idle receive, receipt and reply, and a
clock-only tick. For cross-host verification send a unique correlation challenge
and require the target native session to receive, ACK and reply. A registration, a
roster heartbeat, a successful CLI send or a broker self-check alone is not enough.

## Phase 3 — Bootstrap the field orchestrator

> **Devin-only:** skip; there is no remote orchestrator to start — you are it.
> Spawn workers per `references/devin.md` → Phase 3.

From the Helm, start the remote orchestrator. **Prefix its workspace or worktree
name with `nw-<scope>-`**, using the same `<scope>` as the actor id and the run
manifest from Phase 2 (for example `nw-widget-refactor-orchestrator`). Every
workspace or worktree this run creates, on either host, carries it. The bare `nw-`
prefix only separates nightwatch runs from other work; the `<scope>` part is what
limits a Phase 8 cleanup to **this run's** workspaces and keeps it away from a
different nightwatch run that is still live. Never filter Phase 8 cleanup on `nw-`
alone.

Capture the returned terminal or pane id, the exact host, workspace or socket, an
explicit cwd and base branch, and the selected preset, runtime and effort options.
Launch prompts include the mesh actor id and the common registration and receipt
instructions. Do not infer native conversation ids from manager terminal ids.
Superset terminal delivery requires a terminal-kind launch; the built-in chat is
not a terminal target.

**Every backend needs the same hardening:**

- pre-seed **folder trust** and use `--dangerously-skip-permissions` for Claude Code
  (a headless start otherwise stalls on the first-run trust prompt). For Codex,
  pass `--dangerously-bypass-approvals-and-sandbox` (`--yolo`) explicitly in the
  launch command or a verified run-specific preset for every role (Helm,
  orchestrator, workers, reviewer), including authorized resumes and replacements.
  `--approve-for-me` is not equivalent: it keeps the sandbox and automatic approval
  review. Verify the installed CLI's support and the effective mode in Phase 4;
- a large Node heap (`NODE_OPTIONS=--max-old-space-size=8192`) and
  `UV_USE_IO_URING=0` (Node 24's io_uring can hang under a sandbox seccomp profile);
- **verify the worktree base on disk** (`git merge-base --is-ancestor <base> HEAD`
  plus a spot check of a known file). Both backends can silently fork from the wrong
  base.

YOLO removes sandbox and approval checks. Use it only in execution environments the
Captain has authorized and isolated outside the agent (a dedicated VM or container),
not just a git worktree. Task boundaries still apply: do not change global
permissions, override managed policy, restart an existing fleet, or bypass an
earlier denial because this skill is loaded. If the host or policy cannot support
this mode, report a launch blocker. See `SECURITY.md` in the repository and
[OpenAI's approval-mode documentation](https://learn.chatgpt.com/docs/agent-approvals-security).

→ **Superset**: [`references/superset.md`](references/superset.md) § Phase 3.
→ **Herdr**: [`references/herdr.md`](references/herdr.md) § Phase 3, including the
SSH login-shell trap and the `--session nightwatch` convention.

Hand the orchestrator the plan, the ticket bodies, and the run's notes on known
failure modes. Make it register, verify receive-and-reply and its clock, then
**stand by for an explicit greenlight** (it must not build before the plan is
final).

**Visual-verification bootstrap (so a worker can screenshot its own UI
headlessly).** Put this in the remote box's worker shell profile once; every ticket
then inherits it. It uses the `agent-browser` CLI, which bundles its own Chrome for
Testing, so it needs no `apt`, no Xvfb and no `DISPLAY`:

```bash
export PATH="$HOME/.npm-global/bin:$PATH"   # where a user-level global npm install puts agent-browser
export UV_USE_IO_URING=0                     # Node 24 fs operations can hang under a sandbox seccomp profile
export AGENT_BROWSER_ARGS="--no-sandbox"     # Ubuntu 24.04 AppArmor blocks Chrome's user-namespace sandbox
npm i -g agent-browser && agent-browser install   # idempotent; downloads its own Chrome

# Gate on this smoke test, not on `agent-browser doctor`: doctor's launch probe
# ignores AGENT_BROWSER_ARGS and can report a false failure.
agent-browser open https://example.com && agent-browser screenshot /tmp/ab-smoke.png
file /tmp/ab-smoke.png   # must be a real PNG; then: agent-browser close
```

`agent-browser install --with-deps` (installs Chrome's shared libraries with `apt`;
needs sudo) is only for slim images that lack them.

## Phase 4 — Preflight checkpoint (before the Helm sleeps)

> **Devin-only:** no `preflight.sh`; use the readiness list in
> `references/devin.md` → Phase 4.

The morning review depends on state that is easy to get wrong. Run the local
delivery gate in **each receiving actor's own host context**. The command is the
same on every backend:

```bash
# An orchestrator (a received daemon tick is required):
AGENT_MESH_ID=<actor-mesh-id> "$NIGHTWATCH_HOME/agent-mesh/preflight.sh"
# A role that receives no ticks:
AGENT_MESH_ID=<actor-mesh-id> MESH_REQUIRE_TICK=0 "$NIGHTWATCH_HOME/agent-mesh/preflight.sh"
```

`AGENT_MESH_ID` and `MESH_REQUIRE_TICK` are its only inputs (without
`AGENT_MESH_ID` it checks the wrapper's own identity). It reads
`agent-mesh delivery` for that actor and fails unless this daemon owns the
binding, wakeup is automatic, the target is a verified dedicated agent, a receipt
landed within the last five minutes, the pending batch is not ambiguous or
exhausted, and (unless `MESH_REQUIRE_TICK=0`) a clock tick was received and
acknowledged. It refuses polling-only mode.

It checks nothing on another host and nothing about the run. Check these by hand
and record them in the run log: the remote orchestrator is registered and answers
(`agent-mesh lookup --id <id>` plus a correlation round trip; `online` alone is
only a heartbeat), the run's orchestrator log is tracked on its branch, and the
backend can spawn (Superset: the orchestrator's `superset` CLI works in its spawn
environment and `superset hosts list --json` lists the laptop host; MCP is not
needed; Herdr: the Helm runs inside the named Herdr session). It
cannot prove remote spawning or an actual human response.

Before readiness also verify: real CLI access in the daemon and spawn environment,
host reachability, the designated spawner's configured preset and supported
options, explicit Codex YOLO arguments and the effective mode for every run-owned
Codex session, a cross-host native-session receive-and-reply, the correct cwd and
base, and runtime trust and authentication. Record this evidence in the run log. For Monitor mode, record the actual harness
wake and clock proof there; the script does not attest Monitor readiness.

Stay registered and keep managed agents running. There is no managed revival
fallback. Legacy guarded Claude revival only applies to owners that have really
exited; it cannot prove future revival while the process is still live. Never
resume a live process elsewhere. A replacement changes the binding generation and
keeps worktree and context ownership; moving an actor to another host needs a fresh
actor id and a deliberate hand-off to its publishers.

## Phase 5 — Overnight run

> **Devin-only:** the gate below applies unchanged; liveness, blocker handling,
> re-dispatch and the logged gate exceptions are in `references/devin.md` → Phase 5.

The remote orchestrator orders the build itself (schema and foundations first,
de-risking spikes before the linchpin), starts workers within the **global**
concurrency cap (counted across *both* orchestrators), and supervises on daemon
ticks (or Monitor ticks) plus liveness review. A failed adapter is unavailable, not
merely idle; inspect its pending and error state on the owner host.

**`online` in the mesh roster is not enough. It proves the process is alive, not
that it responds.** An agent stuck on its own dialog (`AskUserQuestion`,
`request_user_input`, or a separate trust or approval prompt) still shows `online`
and will never answer a mesh message. On every TICK, treat **"online but silent past
your threshold" as suspect**, and read the pane or agent directly:

- **Superset**: read the agent's terminal output.
- **Herdr**: `herdr agent read <name> --source detection`; see
  [`references/herdr.md`](references/herdr.md) § Phase 5 for why (`pane read` is not
  reliable here).

Gate **every** PR. Merge-ready means ALL of:

- your review bot's **explicit pass verdict for the PR head**, not an older comment:
  confirm the reviewed commit equals the head. **Some bots review only the first
  push** (Greptile does on some repositories): after every later push, ask for a
  new review in a PR comment (for Greptile, `@greptile please review again`) and
  wait until the reviewed commit is the new head. Put this in every worker's spawn
  prompt; a worker that waits for a review that never comes stalls all night;
- every check run green. A **DIRTY or conflicting PR silently skips CI** ("few
  checks, all green" is the tell);
- **0 unresolved review threads** AND **0 outstanding review comments outside the
  diff** (a separate channel that a threads-only gate misses);
- the PR body read for `🚧 BLOCKER`, "deviation" and "deferred" flags;
- scope within the run's change policy: areas the Captain excluded (for example
  schema, auth, billing) touched only where the plan says so, and no production
  change (data edits, reruns, production jobs), which stays with an engineer.

Survive death: **commit and push first** on every respawn. **Superset**: respawn
into the **existing** workspace (`superset agents create`), never a fresh
`superset workspaces create`, which resets the worktree and orphans the mesh id.
**Herdr**: respawn into the existing pane and worktree
(`herdr agent start <name> --kind <claude-or-codex> --pane <existing-pane-id>`;
Herdr clears an agent name when its process exits, so the pane is free again),
never a fresh `herdr worktree create`. Treat an `agent-died` event as
**park-and-replace**: re-dispatch `meta.ticket` to a fresh agent.

> Known failure mode: a **simultaneous fleet die-off**. Every Superset terminal is a
> child of the host service, so an out-of-memory kill inside that service's cgroup
> restarts the service and kills every orchestrator and worker at once, while
> `uptime` keeps counting. In the cases we saw, a headless Chrome from a browser check
> was killed first and the Superset service processes restarted about 30 seconds
> later. Diagnose with `dmesg -T | grep -i oom` and
> `ps -eo lstart,cmd | grep superset`. Prevent it: one shared dev server per host,
> `agent-browser close` after every check, at most 3 workers on a 64 GB box, and
> 16 GB free before spawns and cold typechecks. Recover with push-first plus
> `claude --continue` in the existing worktrees.

## Phase 6 — Master-PR consolidation

When the Captain wants N gated PRs to land with one approval:

- Build an integration branch that merges each gated component as a **real merge
  commit** (no squash, so attribution survives); verify the ancestry contains
  **exactly** the gated heads.
- **Re-gate the merged head.** A batch-wide review finds things the per-component
  reviews missed (this is where out-of-diff misses show up). Run lint, typecheck and
  the relevant tests on the merged code.
- Close the component PRs as **superseded** (`gh pr close`; their commits are in the
  batch) with a pointer comment and a "reopen if you merge individually" note, only
  after the batch is verified merge-ready.
- Write the morning **test plan** to `untracked/review-plan.json` (the schema is in
  the `human-review` skill) and seed the data it walks through. **Plan-file cwd
  trap:** write it from the reviewer agent (which runs in the worktree) or with an
  explicit absolute worktree path, not from a bare Superset terminal or a Herdr pane
  split without `--cwd <worktree-root>`. With the wrong cwd,
  `git rev-parse --show-toplevel` falls back to `$HOME`, the file lands in the wrong
  directory, and the reviewer tool finds no plan (the overlay's panel says the plan
  file is missing; comments still work). Check that it parses to the expected
  features after writing; a tool that re-reads the file on each request picks up a
  late plan on a browser refresh.

## Phase 7 — Morning review (spawned on the Captain's laptop)

> **Devin-only:** no laptop spawn and no reviewer tool; replaced by the master-PR
> test-plan comment and a recorded end-to-end run in `references/devin.md` → Phase 7.

The remote orchestrator **watches the mesh for the Captain registering**, then a
reviewer is started on the laptop. Which side does the spawning depends on the
backend:

The designated spawner uses verified Superset CLI cross-host access, or drives an
explicit Herdr socket on the laptop (locally or over authorized SSH). If the Helm
must act locally, its existing process needs verified push delivery; do not assume a
mesh message revives it. Choose Claude Code or Codex presets explicitly.

Either way the spawn is **three separate pieces**, so the dev server outlives the
agent that sets it up. Guard against the three ways this goes wrong: the server
started with `nohup` inside the agent (it dies with the agent), feedback aimed at
the remote orchestrator instead of the reviewer, and the mesh assumed to work
without a check. Command sequences:

→ **Superset**: [`references/superset.md`](references/superset.md) § Phase 7.
→ **Herdr**: [`references/herdr.md`](references/herdr.md) § Phase 7.

Default the feedback target to the **local** reviewer agent, so the Captain can
watch a local agent handle the comments; a remote PR author stays selectable in the
reviewer tool. The Captain signs in, sees the test plan in the reviewer tool, drops
pinned-screenshot comments, and each one arrives as a `ui-review` note in the
reviewer agent's inbox. The agent acts and replies.

→ The test-plan schema, the `ui-review` contract and the optional overlay: the
**`human-review`** skill.

## Phase 8 — Clean up after yourself

> **Devin-only:** no `teardown.sh`; see `references/devin.md` → Phase 8.

Leave the mesh and the hosts as clean as you found them:

```bash
"$NIGHTWATCH_HOME/agent-mesh/teardown.sh" <reviewer-id> <throwaway-worker-id> ...
```

- It checks the generation and **retires exactly the named managed actors**,
  cancelling timers and keeping their inboxes. Legacy actors are reported for
  deliberate manual cleanup. It never drains unread mail or kills processes in bulk.
  It lists leftover dev servers and Docker containers (set
  `AGENT_MESH_TEARDOWN_CONTAINERS` to a regex for your per-worktree containers).
- **Stay registered for long-lived ids.** A `stale` id is fine; unregistering
  deletes its inbox and frees the name on an unauthenticated broker.
- Delete the run's workspaces, panes and terminals, filtered to the **exact
  `nw-<scope>-` prefix from Phase 3** (not the bare `nw-`):
  → **Superset**: [`references/superset.md`](references/superset.md) § Phase 8.
  → **Herdr**: [`references/herdr.md`](references/herdr.md) § Phase 8, including
  when it is safe to close the shared `nightwatch` session.

## Logging discipline

Write `<scope>-orchestrator-log.md` (in your repository's notes directory) as the
audit trail: identity, gate verdicts with timestamps, spike decisions, blockers.
**Commit it on the orchestrator branch** and keep it out of the final PR diff.
Tracked logs survive; an untracked run log is lost when the worktree is cleaned up.

## Where to explore

- **`agent-mesh` skill**, `$NIGHTWATCH_HOME/agent-mesh/README.md` and
  `$NIGHTWATCH_HOME/docs/` (DELIVERY, DEPLOY, RESILIENCE, SUPERVISOR, VERIFICATION):
  the substrate.
- **`plan-review` skill**: the Phase 1 plan-refinement loop.
- **`human-review` skill**: the reviewer end of the mesh.
- **`references/devin.md`**, **`references/superset.md`**, **`references/herdr.md`**:
  the per-backend commands.
