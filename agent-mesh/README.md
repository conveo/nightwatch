# agent-mesh

A message bus for Claude Code and Codex CLI agents. Agents address each other by
id. Messages are durable, ordered and replayable (Redis Streams). A daemon on each
host owns the only Redis connection, serves a local Unix-socket API, and delivers
messages through a verified adapter, an explicitly declared Monitor, or polling.

```
 agent process --(unix socket)--> daemon --(Redis Streams)--> daemon --(deliver)--> agent process
   worker-a          host A: owns the Redis connection        host B     terminal / pane / inbox
```

Start with the [quickstart in the repository README](../README.md#quickstart-about-5-minutes).

## Why a daemon per host

Agents run on several hosts: a laptop and one or more remote machines. A shared file
cannot span them, and a central hub service is one more thing to run. The only
shared component is Redis. Every host runs the same daemon; there is no special
orchestrator process.

## Requirements

- Node 22 or later, and pnpm 12.
- A Redis that every daemon can reach. On one machine, a local Redis is enough
  (`docker compose up -d` at the repo root). For several hosts, use a Redis they can
  all reach, over TLS (`rediss://`) unless it is on loopback. See
  [docs/DEPLOY.md](../docs/DEPLOY.md).

## Components

| File | Role |
| --- | --- |
| `src/hub.ts` | Core operations over Redis: register, lookup, publish, read, thread. |
| `src/daemon.ts` | The per-host daemon: owns Redis, serves the socket API, runs delivery and heartbeats. |
| `src/cli.ts` | The `agent-mesh` CLI. A client of the local socket; it never connects to Redis. |
| `src/daemon-client.ts` | The socket client used by the CLI and tests. |
| `src/redis.ts` | Redis clients that reconnect forever. See [docs/RESILIENCE.md](../docs/RESILIENCE.md). |
| `src/identity.ts` | Default agent id: `<worktree>.<host>.<session8>`. |
| `src/local-store.ts`, `src/inbox-store.ts`, `src/persistence.ts` | Host-local inbox, cursors and registrations, written atomically. |
| `src/managed-delivery.ts`, `src/superset-delivery.ts` | Detects and verifies the session's manager (Superset or Herdr), and the typed CLI calls into it. |
| `src/managed-scheduler.ts`, `src/wakeups.ts` | Pending batches, receipts, retries and daemon ticks. |
| `src/delivery.ts`, `src/claude-delivery.ts` | Older direct transports: `sse`, `claude-resume`, `fifo`, `file`, `exec`. |
| `src/ui-server.ts`, `dashboard/` | The local web dashboard: roster, messages, composer, Plans tab. |

## Commands

```bash
pnpm daemon                 # run the daemon (needs AGENT_MESH_REDIS_URL)
pnpm cli <command> ...      # the CLI; or install the wrapper with ./start-local.sh
pnpm ui                     # install and build the dashboard, then serve it on :4747
pnpm ui:dev                 # vite dev server on :5174, proxies /api to the ui-server
pnpm typecheck
pnpm test                   # needs a Redis at AGENT_MESH_REDIS_URL
./verify.sh                 # end to end: Redis, daemon, two agents, message, receipt
./demo.sh                   # scripted demo: blocker, decision, fifo push
```

## Messages

```bash
agent-mesh publish --to orchestrator --type blocker --corr blk-1 \
  --body '{"question":"Which migration goes first?","options":["me","other-worker"]}'
agent-mesh publish --to worker-a --type decision --corr blk-1 --reply <stream-id> \
  --body '{"choice":"me","reason":"schema dependency"}'
agent-mesh inbox --peek     # read the unread tail without consuming it
agent-mesh agents           # the roster, across hosts
agent-mesh lookup --id worker-a
```

- Use the narrowest address: an agent id, `host:<hostname>` for every agent on one
  host, or `broadcast` for the whole mesh.
- Types: `status`, `blocker`, `decision`, `request`, `result`, `note`. Bodies are
  JSON objects. Keep `--corr` and `--reply` to build threads.
- Unknown flags and empty bodies are errors (`--allow-empty` is explicit).

## Delivery and receipt

Read the [delivery contract](../docs/DELIVERY.md) before you rely on unattended
delivery. It covers the exact commands, persistence and ownership, failure and retry
states, timers, and what has been verified.

```bash
agent-mesh register --role implementer --deliver auto
agent-mesh delivery
agent-mesh receive --generation <generation>
agent-mesh receipt --generation <generation> --token <batch-token>
```

- In a dedicated Superset terminal or Herdr pane, add `--dedicated`. The daemon
  then types a short notification into that session when it is idle. Superset
  delivery has live proof on macOS; Herdr has automated tests only.
- Orchestrators add `--tick 15`: the daemon sends a clock tick every 15 minutes even
  when no mail arrives.
- Without a manager, pass `--monitor` if the harness really has a Monitor tool.
  Otherwise the session polls (`automaticWakeup=false`), which is not enough for an
  unattended run.
- A receipt means the agent accepted the batch, not that it finished the work.
  Agents report progress with `status`, `blocker` and `result` messages.
- Older registrations (`--deliver sse|none|claude-resume:SESSION|fifo:PATH|file:PATH|exec:CMD`)
  still work.

## Keeping a host on the mesh

`supervisor.sh` keeps a host's daemon and dashboard running, and restarts them when
the checkout's agent-mesh code is newer than the running code. It does not pull
`main` unless you set `AGENT_MESH_SUPERVISOR_SYNC=1`. On macOS,
`lib/install-supervisor.sh` installs it as a launchd job; on Linux, use a cron line.
See [docs/SUPERVISOR.md](../docs/SUPERVISOR.md).

## Configuration

The common environment variables are in [`.env.example`](.env.example). The rest
are documented with their feature: [CONSOLE.md](../docs/CONSOLE.md),
[DEPLOY.md](../docs/DEPLOY.md), [RESILIENCE.md](../docs/RESILIENCE.md) and
[SUPERVISOR.md](../docs/SUPERVISOR.md).
