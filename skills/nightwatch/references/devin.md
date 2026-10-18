# Nightwatch: Devin-only mode (no mesh, no Redis, no Superset/Herdr)

The whole loop runs inside Devin: **one persistent Devin session is the
orchestrator** (the Helm and the field orchestrator are one actor; there is no
laptop/remote split), **workers are Devin child sessions**, and **GitHub is the
durable state** (branches, PRs, the committed orchestrator log). Nothing from
`agent-mesh/`, `preflight.sh`, `teardown.sh` or a reviewer tool is used. Phases 1,
5 and 6 of `SKILL.md` apply as written; Phases 2, 3, 4, 7 and 8 are replaced by the
sections below.

The failure modes and rules below come from real runs of this mode.

## Detection

You are in Devin-only mode **if and only if you are running as a Devin session**:
the built-in `devin_session_create`, `devin_session_interact` and
`devin_session_search` tools exist (and `$DEVIN_DIR` is set in the shell). It is an
execution backend, not a fallback: a Claude Code or Codex session without a mesh
broker, Superset or Herdr cannot start Devin children and must report a launch
blocker instead of choosing this mode.

A Devin orchestrator takes this mode even if a mesh is reachable: it has no
dedicated pane for mesh delivery and would be polling-only, which `SKILL.md`
Phase 2 rejects. Record the detected mode as the first line of the orchestrator log.

## Substitutions at a glance

| Mesh nightwatch                                  | Devin-only                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| Helm + field orchestrator (co-equal)             | one orchestrator Devin session                                            |
| worker = Claude Code/Codex CLI in a pane         | worker = Devin child session (`devin_session_create`)                     |
| mesh actor id `nw-<scope>-<role>-<unique>`       | session tag `nw-<scope>`, title `nw-<scope> <ticket-id> <slug>`           |
| `publish note / blocker`                         | worker `structured_output` (`status`, `assumptions`, `blocker`)           |
| mesh message to a worker                         | `devin_session_interact action=message` (wakes a sleeping session)        |
| `watch --tick` / roster liveness                 | `notify_on_response=true` + `devin_session_interact action=get` sweep     |
| pane read to detect a stuck dialog               | `status_detail` + `get_messages` of the child                             |
| `preflight.sh`                                   | the preflight checklist below                                             |
| reviewer tool + `ui-review` notes                | test-plan comment on the master PR + a recorded local end-to-end run      |
| `teardown.sh` + workspace sweep                  | session sweep by tag + branch delete of merged/superseded `nw-<scope>-*`  |

## Kickoff prompt (what the Captain pastes into a fresh Devin session)

```
You are the nightwatch orchestrator for ticket <TICKET> in <owner>/<repo>.
Read the nightwatch skill (SKILL.md) and follow references/devin.md
(Devin-only mode). Scope `<scope>`, base `main`. Start with Phase 1 and STOP
for my explicit greenlight before spawning anything. You may use Devin's testing
agent (`testing_agent`) for the Phase 7 end-to-end run.
```

Everything else (tags, branch names, log path, worker clause, gate, cadence) is
defined here, so the prompt stays short. Override any parameter inline.

## Run parameters (defaults)

- **scope**: the lower-cased ticket key, for example `proj-123`.
- **tag**: `nw-<scope>` on every session the run creates.
- **branches**: `nw-<scope>-<ticket-slug>` per worker, `nw-<scope>-orchestrator`
  for the plan and log, `nw-<scope>-master` for the consolidated PR. All from
  `origin/main` unless the Captain says otherwise.
- **audit log**: `notes/<scope>-orchestrator-log.md` on the orchestrator branch,
  committed and pushed after **every** gate verdict, spike decision, blocker and
  Captain decision. Also commit `notes/<scope>-plan.md`, `notes/<scope>-tickets.md`
  and the worker prompts (`notes/<scope>-prompts/`) there. A copy of the prompts
  that lived only on the orchestrator VM was the one artefact a run could not hand
  over.
- **concurrency cap**: 3 worker sessions at once. This is a hard cap that the
  orchestrator counts itself; nothing enforces it for you.
- **reporting**: the Captain hears only gate verdicts, blockers and stuck states
  (`message_user`, non-blocking). Block only for the greenlight, for a decision you
  cannot take conservatively, and at the end.

## Phase 1 — Plan (as in SKILL.md, plus)

- Pull the ticket from your tracker (title, body, comments, linked issues). If a
  spec path named in the ticket is not on `origin/main`, the ticket body is the
  spec; log that.
- Mirror the tickets into `notes/<scope>-tickets.md`. Workers may have tracker
  access, but the file is what the prompt embeds and what survives.
- For every ticket: dependencies, lane, serialization points, closed verification
  loop, acceptance criteria. State the **dependent-branching rule** in the plan: a
  dependent worker branches from `origin/main` and, as its **first commit**, runs
  `git merge --no-ff <dep SHA>` of the dependency branch `nw-<scope>-<dep>` (no
  rebase, no cherry-pick). The SHA pinned in the brief is the dependency's head **at
  spawn time**: its gated head if the dependency is already gated, otherwise the
  head that met the unlock condition (Phase 3). In the second case the orchestrator
  sends the dependency's gated SHA to the dependent once the gate passes, and the
  dependent lands a **second** `git merge --no-ff` of it before it marks the PR
  ready. The gate for a dependent checks that the dependency's gated head is an
  ancestor of the dependent's `head_sha`. If a dependency's head moves after its
  gate, re-verify the new head against the full gate before dependents take it.
- Post the summary as a comment on the ticket, commit plan, tickets and log, run the
  Phase 2 preflight below, and only then send `message_user(block_on_user=true)` for
  the greenlight. A failed preflight item is a blocker in that message, never
  something to discover after the Captain has left. Bundle any decision you need
  into the same message: one round trip, not several.

## Phase 2 replacement — Preflight (with the plan, before greenlight)

Record every line in the log:

1. `gh auth status` succeeds (as the Devin GitHub app's bot user) and `git push` to
   the orchestrator branch works.
2. Your review bot reviews this repository: a recent PR shows its verdict and the
   commit it reviewed.
3. Which other bots post here, and **how**: review threads posted only after a PR is
   marked ready; top-level marker comments instead of threads (a threads-only gate
   misses them); bots that push commits on top of a worker's head (for example
   screenshot updates); auto-merge bots that approve or merge by policy (see
   Phase 5).
4. The child-session surface: the built-in `devin_session_create` uses
   `POST /v3/organizations/{org_id}/sessions` and supports `tags`, `title`,
   `structured_output_schema`, `structured_output_required` and batch-level
   `devin_mode`. It has **no** `max_acu_limit`, and v3 has **no** `idempotent`
   field; see Phase 3 for what replaces both. Hard ACU caps need a v3 service-user
   API key instead; ask at greenlight, not mid-run.
5. Local verification works on the orchestrator VM: the repository's setup
   commands (start services, reset the test database) run, so Phase 6 can run the
   tests. Log any test that fails only because a local secret is missing.

## Phase 3 replacement — Spawn workers

Spawn with `devin_session_create`. Devin requires its own `managing-child-sessions`
skill to be loaded before this tool, so load it first:

- `tags: ["nw-<scope>"]`, `title: "nw-<scope> <T#> <slug>"`,
  `repos: ["<owner>/<repo>"]`, `notify_on_response: true`,
  `structured_output_required: true` (explicit: Phase 5 branches on `status`, so a
  child must not be able to finish without it).
- `structured_output_schema` (every worker, verbatim):

  ```json
  {
    "type": "object",
    "properties": {
      "pr_url": { "type": ["string", "null"] },
      "head_sha": { "type": ["string", "null"] },
      "status": { "type": "string", "enum": ["merge-ready", "in-progress", "blocked"] },
      "assumptions": { "type": "array", "items": { "type": "string" } },
      "blocker": { "type": ["string", "null"] }
    },
    "required": ["pr_url", "head_sha", "status", "assumptions", "blocker"]
  }
  ```

- **Idempotency**: before creating, run `devin_session_search(tags=["nw-<scope>"])`
  and skip any live session whose title matches the ticket. This replaces the
  missing `idempotent` flag.
- **ACU budget**: size one per ticket in the plan (one run used 25 for the
  linchpin and 15 for preparation tickets) and enforce it yourself. The budget is
  **per ticket, cumulative across every session created for it**: keep a
  `ticket → [session, acus_consumed]` table in the log, sum `acus_consumed` (from
  `devin_session_interact action=get`) over all of them on every sweep, and give a
  re-dispatched session only the **remainder** in its brief. Cumulative over budget:
  `terminate` the live session; re-dispatch (below) only if a remainder is left,
  otherwise it is a blocker for the Captain. Freeze a finished session's final
  `acus_consumed` into the table, so a re-dispatch never resets the count.
- `devin_mode` is batch-level only. Choose it per wave.

**Every worker prompt contains**, in this order: the ticket body and acceptance
criteria from `notes/<scope>-tickets.md`; its verification loop; its branch name
and base (`origin/main`, plus the dependent-branching rule with the pinned
dependency SHA when it applies); the serialization points it must **not** touch;
the repository's own conventions (its `AGENTS.md` or `CLAUDE.md`); the gate it must
reach; and the **Devin anti-blocking clause, verbatim**:

> Never wait on a clarifying question. Pick the most conservative sane default,
> list it under `assumptions` in your structured output and in the PR body, and
> continue. Commit and push after every meaningful step. Open the PR as a draft
> early and mark it ready only when the gate passes. Only a genuine blocker
> justifies stopping: set `status=blocked` with a one-line `blocker`, push, and
> end. Never enable auto-merge on your PR.

Order: schema and foundations first, de-risking spikes before the linchpin, then
parallel lanes, never more than 3 live sessions. A dependent may start as soon as
its dependency's **unlock condition** is met (for example, the schema check is green
on the schema PR), not only after the full gate. Its first commit merges the
dependency's head at unlock time, it commits freely on top, and it lands a second
`git merge --no-ff` of the dependency's *gated* head (sent by the orchestrator)
before it marks the PR ready; see the dependent-branching rule in Phase 1.

## Phase 4 replacement — Readiness before the Captain sleeps

There is no `preflight.sh`. Before the Captain leaves, confirm and log:

- every live worker has produced at least one `structured_output` and a draft PR URL
  (proof that the child understood the brief and can push);
- `notify_on_response` was passed on every create and message, so you are woken
  when a child settles even if you have suspended. While any child is live, stay in
  the sweep loop below (bounded `wait` calls between sweeps). A Devin session
  suspends only when it stops issuing tool calls, so an idle wait-and-sweep loop is
  what keeps supervision running; the notification is the safety net if the loop is
  interrupted;
- the orchestrator branch is pushed with plan, tickets, prompts and log;
- the concurrency cap and the ACU budgets are written in the log.

## Phase 5 — Supervision and gating (SKILL.md applies; Devin specifics)

**Liveness.** While anything is live, run the sweep loop: `wait` (at most 565 s per
call, about 10 minutes between sweeps), then `devin_session_interact action=get` for
each child to read `status`, `status_detail`, `structured_output`, `pull_requests`
and `acus_consumed`. `notify_on_response` also wakes you the moment a child
finishes, blocks or exits; sweep on those wakes too. Never leave the loop with
children live: a silent child using ACUs is only caught by the sweep.
`status_detail` = waiting for user or blocked is the Devin version of a pane stuck
on a dialog: read `get_messages`, decide conservatively, send the decision with
`action=message` (`notify_on_response=true`), and log it.

**When a child ends without `status=merge-ready`, branch on what it reported:**

- `status=blocked`: **do not re-dispatch.** Log the `blocker`, park the ticket, and
  tell the Captain (non-blocking `message_user`; blocking only if the run cannot
  continue without it). Re-dispatch only once the blocker is resolved, with the
  resolution in the brief.
- `status=in-progress`, a terminated or over-budget session, or an exit with no
  structured output: **re-dispatch a new session for the same ticket** with "branch
  `nw-<scope>-<slug>` already exists on origin with partial work; continue from its
  HEAD". Never restart a ticket from `main`. At most two re-dispatches per ticket; a
  third failure is a blocker for the Captain.

**Steering a live worker.** Message its session: it owns the worktree and the
branch. Mentioning Devin in a PR comment starts a *new* session; keep that for a
worker that is gone and a fix too small to re-dispatch.

**Gate — merge-ready means ALL of** the `SKILL.md` Phase 5 list, checked with
`git_view_pr` or `gh api` on the PR at `head_sha`:

- your review bot's pass verdict for exactly the head commit. If the new head has no
  review yet, ask the bot to review it;
- every check green; the PR `mergeable` and not dirty (a conflicting PR silently
  skips CI; "few checks, all green" is a fail);
- 0 unresolved review threads **and** 0 outstanding top-level bot comments (a
  blocking severity blocks; an advisory one is logged as accepted or as a
  follow-up);
- a PR body free of `🚧 BLOCKER`, "deviation" and "deferred" flags (a code comment
  about a deferred change is not a flag; read each hit);
- **wait for the reviewers that run after readiness.** Devin Review posts its
  threads only after the PR is marked ready, and other bots re-run on new heads. A
  PR that was "passed, all green, 0 threads" at readiness gained 4 threads ten
  minutes later on one run. Poll again after readiness before you record PASS; a
  PASS recorded too early is reopened, not amended;
- your own review of the diff against the ticket, every time.

**Logged exceptions that are fine:**

- The head is a bot's **screenshot-only commit** and CI skipped it by design (all
  jobs skipped by the changed-files filter): accept when the parent commit has the
  full suite green and `head~1..head` changes only images.
- An **auto-merge bot declines by policy** (migrations, destructive changes): not a
  gate failure.

**Known failure modes (from real runs):**

- **A gated component lands on `main` before the master.** On one run a person
  merged a component mid-run, and an auto-merge bot approved another the moment it
  was ready. Workers must never enable auto-merge. If a component lands anyway,
  dependents take it from `main` and the master merges only the remaining gated
  heads. Log the deviation; do not fight it.
- **A review finding targets dependency code** carried into a dependent PR (a bot's
  blocking comment on the dependency's query, raised on the dependent's PR). If the
  dependency's worker has finished, the dependent's worker owns the fix; note it in
  both PRs' logs.
- **The same review remark recurs across PRs** (cascade semantics, a missing
  index): decide once, write the reason in the log, and reply and resolve with that
  text wherever it recurs.

## Phase 6 — Consolidation (SKILL.md applies; Devin specifics)

On the orchestrator VM: `nw-<scope>-master` = `origin/main` plus `--no-ff` merges of
exactly the gated heads; check `git merge-base --is-ancestor <head> HEAD` for each.
Re-gate the merged head locally before opening the PR: the repository's code
generation, lint and typecheck commands, focused tests for every touched area, and
one full test run. Open the master PR, mark it ready, and drive it through the same
gate. The batch-wide review finds things the component reviews missed (for
example, a null dereference introduced by a codemod). Fixes go **back to the component branch** (message its worker or
re-dispatch), get re-gated there, and are then merged into the master again. Close
component PRs as superseded only after the master gate passes and the Captain says
so; keep them open until then.

Write `untracked/review-plan.json` from the **repository root** (schema in the
`human-review` skill), check that it parses, and seed the data it walks through
with an idempotent script (run it twice).

## Phase 7 replacement — Morning review without a reviewer tool

Two things replace the reviewer tool:

1. **One comment on the master PR** with: the step-by-step test plan (the features
   of `review-plan.json`), a "verified by orchestrator" section, caveats
   (environment-only test failures, pre-existing warnings, auto-merge policy), and
   the **verbatim assumptions of every worker** from their structured output.
   Attach `review-plan.json` to the orchestrator session too.
2. **A local end-to-end run by Devin's testing agent** (`testing_agent`, approved in
   the kickoff) on the master worktree against the seeded data, recorded. This is
   not optional: on one run it reopened two gates (a wrong count, and a 409 response
   shown as an error page) that CI and both review bots had passed. Attach the
   recording to the gate message.

Then poll the master PR's comments and threads about every 10 minutes (or on each
`notify_on_response` wake) and act on new ones. Report only gate verdicts, blockers
and stuck states. When the master has been stable for a while with nothing left to
decide, send **one** blocking message listing the open calls ("supersede the
components?", "clean up?") and stop polling until the Captain replies.

## Phase 8 replacement — Cleanup (only when the Captain says so)

1. `devin_session_search(tags=["nw-<scope>"])`: every worker is finished or
   suspended; `terminate` any that is still running against a superseded branch.
2. Delete only `nw-<scope>-*` branches whose PRs are **merged or superseded**
   (never by the bare `nw-` prefix; another run may be live). Keep
   `nw-<scope>-master` until it is merged.
3. Leave `nw-<scope>-orchestrator` and its log in place: the tracked log is the
   run's audit trail.
