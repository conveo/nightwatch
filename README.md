# nightwatch

[![CI](https://github.com/conveo/nightwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/conveo/nightwatch/actions/workflows/ci.yml)

nightwatch runs a fleet of coding agents overnight. You plan the work in the afternoon.
Agents build, test and review it while you sleep. In the morning you get one pull
request that has passed every check, and a test plan to walk through.

This repository has three parts:

- `agent-mesh/`: a message bus for Claude Code and Codex CLI agents on one or more
  machines. A daemon on each host, Redis Streams between hosts, agents addressed by id.
- `skills/`: the instructions the agents follow (`nightwatch`, `agent-mesh`,
  `plan-review`, `human-review`).
- `reviewer-overlay/`: an optional browser overlay for any web app in development.
  A person pins a spot on the page, writes a note, and it reaches an agent's mesh
  inbox with a screenshot.

How we use it, and what went wrong on the way: https://engineering.conveo.ai/posts/nightwatch

## The four capabilities

nightwatch needs four things. This repo ships one of them (the bus) and works with
existing tools for the other three. Any tool that provides a capability can replace
the one we use.

| Capability | What it does | What we use | Alternatives |
| --- | --- | --- | --- |
| Spawner | Starts an agent in a fresh worktree, on a named branch, on a chosen host | [Superset](https://docs.superset.sh/cli/cli-reference) or [Herdr](https://herdr.dev/docs/agent-automation/) | `git worktree` + tmux; SSH + the agent CLI |
| Durable message bus | Ordered, replayable messages between agents, addressed by id, across hosts | `agent-mesh` on Redis Streams | NATS JetStream; any log with per-consumer cursors |
| Validation agents | Check that a pull request is ready before a person looks at it | CI plus automated review bots on every PR | Any CI and any review bot that posts a verdict for a specific commit |
| Wake-up | Puts a message into an idle agent's session so it acts now | `agent-mesh` delivery into a dedicated Superset terminal or Herdr pane; Claude Code Monitor | Anything that can inject input into a running agent CLI |

## Roles

| Role | Who | Job |
| --- | --- | --- |
| Captain | a person | Sets the goal, makes the scope and merge decisions, tests in the morning. |
| Helm | an agent on the laptop | Turns the plan into tickets, starts the field orchestrator, shares authority over the fleet. |
| Field orchestrator | an agent on a remote box | Orders the build, starts and supervises workers, checks every PR, works all night. |
| Workers | agents | One ticket and one worktree each. Push often. Stop only when the PR passes the checks. |

## Architecture

```
            laptop                                        remote box
 +----------------------------+                +----------------------------+
 | Captain (person)           |                | field orchestrator (agent) |
 | Helm (agent)               |                | workers (agents), one      |
 | reviewer (agent, morning)  |                | ticket and worktree each   |
 |             |              |                |             |              |
 |      agent-mesh CLI        |                |      agent-mesh CLI        |
 |             | unix socket  |                |             | unix socket  |
 |   agent-mesh daemon <------+--> Redis  <----+--> agent-mesh daemon       |
 |             | wake-up      |    Streams     |             | wake-up      |
 |  Superset terminal, Herdr  |                |  Superset terminal, Herdr  |
 |  pane, Monitor or polling  |                |  pane, Monitor or polling  |
 +----------------------------+                +----------------------------+
               |                                              |
               +-- GitHub: branches, PRs, CI, review bots ----+
```

- Each host runs one daemon. Only the daemon talks to Redis. Agents talk to the
  daemon through a local Unix socket, using the `agent-mesh` CLI.
- The daemon writes every message to a durable inbox file before it does anything
  else, so a message is not lost when an agent is busy or a process restarts.
- The daemon wakes an idle agent by typing a short notification into the agent's own
  terminal (Superset) or pane (Herdr), after it checks that the session is idle and
  owned by that agent. The agent then reads the batch and sends a receipt.
- Without a terminal manager, an agent can use Claude Code's Monitor tool, or it
  polls. A polling agent only sees messages when it is already working.

## Quickstart (about 5 minutes)

You need Node 22.18 or later, pnpm 12, and Docker. Run these steps in a plain terminal,
not inside an agent session or a Superset/Herdr pane: there, `--deliver auto` binds
the test agents to that session.

Terminal 1: install, start Redis, start the daemon.

```bash
git clone https://github.com/conveo/nightwatch.git
cd nightwatch
pnpm install
docker compose up -d                  # Redis on 127.0.0.1:6379
./agent-mesh/start-local.sh --local   # installs ~/.local/bin/agent-mesh, then runs the daemon
```

If port 6379 is taken, pick another one for both commands:
`AGENT_MESH_REDIS_PORT=6390 docker compose up -d`, then
`AGENT_MESH_REDIS_URL=redis://127.0.0.1:6390 ./agent-mesh/start-local.sh --local`.

Terminal 2: register two agents, send a message, receive it, send a receipt, reply.

```bash
export PATH="$HOME/.local/bin:$PATH"
agent-mesh register --id alice --role orchestrator --deliver auto
agent-mesh register --id bob --role implementer --deliver auto
agent-mesh agents

agent-mesh publish --id alice --to bob --type request --corr q-1 --body '{"ask":"which transport?"}'
sleep 1                               # give the daemon a moment to deliver it

# bob reads the outstanding batch, then acknowledges it with the batch token
GEN=$(agent-mesh delivery --id bob | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).transport.generation')
agent-mesh receive --id bob --generation "$GEN"
TOKEN=$(agent-mesh receive --id bob --generation "$GEN" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).batch.token')
agent-mesh receipt --id bob --generation "$GEN" --token "$TOKEN"
agent-mesh delivery --id bob          # "receiptConfirmed": true

agent-mesh publish --id bob --to alice --type result --corr q-1 --body '{"answer":"redis streams"}'
agent-mesh inbox --id alice
```

Terminal 3: the dashboard (the console, roster, messages, Plans tab).

```bash
cd nightwatch
pnpm ui                               # builds the dashboard, serves http://127.0.0.1:4747
```

Set `AGENT_MESH_UI_PORT` to use another port. The dashboard listens on 127.0.0.1
only and has no authentication; to use it on a remote box, tunnel to it (see
[DEPLOY.md](docs/DEPLOY.md#the-dashboard)).

The first tab is the console: a chat-first view of the mesh that also works as a
phone app, with live delivery, push notifications and a transcript that stays on the
host. With `OPENAI_API_KEY` set it adds an assistant you can type or talk to. See
[docs/CONSOLE.md](docs/CONSOLE.md).

Check everything in one command. It runs its own daemon with a separate home
directory, uses `$AGENT_MESH_REDIS_URL` when it is set and otherwise starts a Redis
in Docker, and exits non-zero on any failure:

```bash
./agent-mesh/verify.sh
```

Stop: press Ctrl-C in terminals 1 and 3, then run `docker compose down`. To remove
the CLI and the local state: `rm -rf ~/.local/bin/agent-mesh ~/.agent-mesh`.

In real use each agent session runs `agent-mesh register --deliver auto` itself and
derives its id from its worktree, host and session. See the
[agent-mesh skill](skills/agent-mesh/SKILL.md) and the
[delivery contract](docs/DELIVERY.md).

## Use the skills

The skills are plain Markdown for Claude Code and Codex CLI. They expect two things:
the `agent-mesh` command on `PATH` (installed by `start-local.sh`), and
`NIGHTWATCH_HOME` set to your clone of this repo.

```bash
export NIGHTWATCH_HOME=~/src/nightwatch          # your clone
# Claude Code, for all your projects:
mkdir -p ~/.claude/skills && ln -s "$NIGHTWATCH_HOME"/skills/* ~/.claude/skills/
# Or per project, for Claude Code and Codex CLI:
mkdir -p .claude/skills .codex/skills
ln -s "$NIGHTWATCH_HOME"/skills/* .claude/skills/ && ln -s "$NIGHTWATCH_HOME"/skills/* .codex/skills/
```

Then ask the agent to run `/nightwatch`. The skill detects the backend first:
mesh plus Superset or Herdr, or Devin-only (Devin child sessions, GitHub as the only
shared state, no mesh).

| Skill | Use it for |
| --- | --- |
| [`nightwatch`](skills/nightwatch/SKILL.md) | The whole afternoon-to-morning loop, in eight phases, with references for [Superset](skills/nightwatch/references/superset.md), [Herdr](skills/nightwatch/references/herdr.md) and [Devin-only](skills/nightwatch/references/devin.md). |
| [`agent-mesh`](skills/agent-mesh/SKILL.md) | Register, prove receipt, publish status, blockers and results, supervise with ticks. |
| [`plan-review`](skills/plan-review/SKILL.md) | A person comments on a plan in the dashboard's Plans tab; the planner agent edits it. |
| [`human-review`](skills/human-review/SKILL.md) | A person tests the running app and sends pinned-screenshot comments (`ui-review` notes) to an agent. |

The `human-review` skill documents the message contract, not a specific tool. An
optional browser overlay that sends these messages from any web app lives in
[`reviewer-overlay/`](reviewer-overlay/). Start it with
`pnpm overlay --origin <your app's dev origin> --target <agent id>`.

## Repository layout

```
agent-mesh/          the daemon, CLI, delivery adapters, dashboard, supervisor and scripts
  src/               TypeScript sources and tests (src/test/)
  dashboard/         React dashboard and mesh console (its own pnpm workspace)
  lib/               shell helpers: CLI wrapper install, supervisor install
  verify.sh          end-to-end check: Redis, daemon, two agents, message, receipt
  preflight.sh       read-only delivery readiness check before an unattended run
  teardown.sh        retire the named actors after a run and report leftovers
skills/              the agent skills
reviewer-overlay/    browser overlay and local server that send ui-review notes
examples/nyc-live/   an example app for a nightwatch run to build overnight (three.js, live NYC data)
docs/                console, delivery contract, deployment, resilience, supervisor, verification record
scripts/             maintainer tooling (sync from the upstream monorepo, denylist gate)
docker-compose.yml   a local Redis
```

## What is tested, and what is not

- Delivery into Superset terminals: tested live on macOS with Claude Code and Codex
  CLI. The cross-host round trip was tested with Codex only. See
  [docs/VERIFICATION.md](docs/VERIFICATION.md).
- Delivery into Herdr panes: automated tests with a mocked Herdr CLI only. No live run yet.
- Linux as the receiving host for managed delivery: not tested live.
- The mesh has no authentication. Anyone who can reach the Redis broker can read
  and send messages. Keep the broker on a private network. See [SECURITY.md](SECURITY.md).
- Agents in this setup run with permission prompts turned off. Only do that on
  isolated machines. See [SECURITY.md](SECURITY.md).

## Development

```bash
pnpm install
docker compose up -d
AGENT_MESH_REDIS_URL=redis://127.0.0.1:6379 pnpm test    # needs Redis; uses the key prefix "meshtest"
pnpm typecheck
pnpm dashboard:build
./agent-mesh/verify.sh
pnpm --dir reviewer-overlay typecheck && pnpm --dir reviewer-overlay test && pnpm --dir reviewer-overlay build
```

The agent-mesh code is developed in a private monorepo and copied here with
`scripts/sync-from-monorepo.sh`. See [docs/MAINTAINING.md](docs/MAINTAINING.md).

## Licence

MIT. See [LICENSE](LICENSE). Built at Conveo. The dashboard includes components from
shadcn/ui (MIT) and AI Elements (Apache-2.0); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
