# agent-mesh — redis resilience

How the per-host daemon survives a transient Redis outage and resumes on its own,
with **no message loss** and **no manual restart**. Read alongside `DEPLOY.md`.

## The failure

A transient Redis error could wedge the daemon for hours. The log tail looked like
this:

```
[agent-mesh] redis error: read ETIMEDOUT
[agent-mesh] redis error: Connection timeout   (×~25)
```

…then the daemon stopped delivering messages entirely, and a consumer's
`agent-mesh inbox` eventually failed with `ECONNREFUSED` on `~/.agent-mesh/daemon.sock`.
`agent-mesh inbox --peek` kept returning a **stale local cache**, so the outage was
invisible from the CLI.

## Root cause (two compounding node-redis defaults)

The daemon uses **node-redis** (`redis` v5). It created its clients with **no socket
options**, inheriting two defaults that together turn a blip into a permanent wedge:

1. **`defaultReconnectStrategy` gives up on a timeout.** In
   `@redis/client/.../socket.js` it returns `false` (i.e. *stop reconnecting,
   forever*) the moment the disconnect cause is a `SocketTimeoutError` — exactly the
   "Connection timeout" in the log. Once it gives up, the socket flips
   `isOpen=false` and **every** subsequent command rejects with `ClientClosedError`.
   The delivery loop then spins on a dead client forever → *"stopped delivering"*.

2. **`connectTimeout` only covers the TCP-connect phase.** It is removed the instant
   the socket emits `connect`, so the `HELLO/AUTH` handshake and all steady-state
   reads run with **no timeout** unless `socketTimeout` is set. A half-open or
   blackholed connection (TCP up, server silent) therefore **hangs forever**,
   parking the blocking `XREAD` — and the reconnect strategy never even gets a
   chance to fire.

`heartbeat` failures were swallowed (`.catch(()=>{})`), so `lastSeen` stopped
updating and the agent silently went `stale`; an unhandled rejection from the
reconnect machinery could then crash the process (the `ECONNREFUSED` tail).

## The fix

**`src/redis.ts`** builds every client (shared + blocking) through one resilient
factory:

- **`reconnectStrategy` that never gives up** — capped exponential backoff
  (max 2s) + jitter, always returns a *number*. It can never return `false`/`Error`,
  so the client can never permanently close on a transient fault. The cause is
  logged (rate-limited) so a real outage stays visible in your log aggregator.
- **`socketTimeout`** (default 30s) — arms a socket-inactivity timeout *after*
  connect, so a hung handshake or half-open read is torn down and retried instead
  of hanging forever. Chosen to comfortably exceed both the `XREAD BLOCK` interval
  (~1s) and `pingInterval`, so a healthy idle socket is never killed.
- **`connectTimeout`** bumped to 10s, **`keepAlive`** explicit, and a **`pingInterval`**
  (10s) on the **shared client only** — it keeps an otherwise-idle shared client
  active and surfaces half-open sockets. The blocking client is never idle (XREAD
  BLOCK loop) so a ping there is redundant; `socketTimeout` is its protection.
- Lifecycle logging (`reconnecting` / `ready` / `end` / `error`) and a mandatory
  `error` listener (without one node-redis crashes the process on socket errors).

**`src/daemon.ts`** adds defense-in-depth so the process can never die or stay wedged:

- **Global process guards.** `unhandledRejection` (the async Redis crash path
  described above) is always kept alive — a reconnect storm can emit a burst of
  rejections and exiting on those would reintroduce the wedge. `uncaughtException`
  is the opposite: a *sync* throw leaves the process in an undefined state (Node's
  own guidance), so we log and **exit non-zero** for a clean restart (the skill
  re-bootstraps the daemon whenever `agent-mesh health` fails; the singleton-lock
  release frees the pidfile on exit) rather than limp on with half-updated state
  while reporting healthy. Logged rejection causes are sanitized (name+message,
  newline-stripped, length-capped).
- **Self-healing blocking client** — if the blocking client ever ends up closed,
  the delivery loop rebuilds it. Delivery cursors are persisted in `state.json`, so
  a rebuilt client **resumes from the last delivered id** (no loss, no dupes).
- **Watchdog loop** — every 10s it rebuilds a closed client, resets the shared
  singleton if needed, and detects a *stalled* consumer (connected/`isReady` but no
  `XREAD` completed for 30s) and forces a rebuild. It deliberately does **not**
  rebuild while disconnected — that path belongs to the reconnect machinery.
- **Delivery never wedges on a per-message failure.** Routing a message is wrapped
  so a *synchronous* throw on the consume side — `appendToInbox` hitting a full/again
  disk (ENOSPC/EACCES), an SSE write to a half-dead client — cannot unwind the
  delivery loop. The bad message is logged and skipped (it stays durable in the
  Redis stream, readable via `/history`) and the cursor still advances, so one
  message can neither head-of-line-block nor busy-loop the consumer.
- **Supervised loops.** Every background loop (delivery, heartbeat, liveness-sweep,
  watchdog) runs under a supervisor that restarts it if it ever throws or returns
  while the daemon is still running — the restart mechanism the watchdog itself
  lacked for a crashed loop. Combined with the per-message guard above, the delivery
  loop cannot silently die.

Resume-from-last-id was already correct: `deliverCursor` is persisted per agent and
fed to `XREAD`, and only advances *after* a message is delivered. The fix keeps the
loop alive long enough for that existing machinery to do its job.

## Tuning knobs (env)

All optional; sensible defaults baked in.

| Env var | Default | Purpose |
|---|---|---|
| `AGENT_MESH_REDIS_CONNECT_TIMEOUT_MS` | `10000` | TCP connect timeout |
| `AGENT_MESH_REDIS_SOCKET_TIMEOUT_MS` | `30000` | socket-inactivity timeout (handshake + reads) |
| `AGENT_MESH_REDIS_PING_INTERVAL_MS` | `10000` | idle PING / half-open detection |
| `AGENT_MESH_REDIS_KEEPALIVE_MS` | `5000` | TCP keep-alive initial delay |

## Test

`pnpm --dir agent-mesh test:resilience` (`src/test/test-resilience.ts`) proves
auto-recovery against a **fully isolated stack** — a throwaway docker Redis on an
ephemeral port, an isolated daemon (own home/socket/key-prefix), and an in-process
TCP **fault-proxy** that blackholes the connection to reproduce the exact
`SocketTimeoutError` cause. It asserts:

- (a) the daemon **process survives** a ~32s outage (health ok throughout);
- (b) messages published **during and after** the outage are delivered;
- (c) the consumer **resumes from the correct cursor** — exactly 3 messages,
  in order, no loss, no re-delivery of the pre-outage message;
- (d) recovery is **automatic and bounded** (observed ~0.5s after Redis returns);
- (e) a **per-message delivery failure** (forced via an `EISDIR` obstruction on the
  inbox file, so `appendToInbox` throws) does **not** kill the delivery loop — the
  daemon stays healthy and keeps delivering later messages.

It is CI-safe: it prints `SKIP` and exits 0 if docker is unavailable. It is also a
real regression guard — reverting the `redis.ts` socket options makes it fail
(the daemon stays up but never resumes delivery, the failure described above).

It **never** touches the host's live daemon or a shared Redis.
