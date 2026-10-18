// Dedicated Redis clients for the agent hub. The daemon owns these — they are
// the ONLY Redis connections on the host. Reads AGENT_MESH_REDIS_URL (the broker
// every host shares), falling back to REDIS_URL for local single-host testing.
//
// Two kinds of client:
//   - getMeshRedis(): a shared client for quick non-blocking ops (XADD, HSET, …).
//   - createMeshBlockingClient(): a fresh, dedicated connection for XREAD BLOCK —
//     a blocking command monopolises its connection, so it must not be shared.
//
// RESILIENCE (the 2026-06-13 incident): a transient redis blip wedged the daemon
// for ~10h. Root cause was node-redis' DEFAULT reconnect strategy, which returns
// `false` (i.e. gives up reconnecting PERMANENTLY) the moment the disconnect cause
// is a `SocketTimeoutError` — exactly the "Connection timeout" seen in the logs.
// Once the strategy gives up, the socket flips `isOpen=false` and every later
// command rejects with `ClientClosedError`, so the delivery loop spins on a dead
// client forever. We override that here with a strategy that NEVER gives up.

import { createClient } from "redis"
import { log } from "./log.js"

export type MeshRedis = ReturnType<typeof createClient>

export function meshRedisUrl(): string {
  return process.env.AGENT_MESH_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379"
}

// Read a positive integer env override, falling back if unset OR below `min`.
// The `min` floor matters for socketTimeout: a value at/below the XREAD BLOCK
// interval would destroy the blocking socket before every response arrives,
// creating a constant reconnect loop — so a misconfig falls back to the safe
// default rather than self-inflicting the very wedge this module prevents.
function envInt(name: string, fallback: number, min = 1): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= min ? raw : fallback
}

// socketTimeout must comfortably exceed the daemon's XREAD BLOCK (~1s) and the
// pingInterval; floor it well above 1s so no override (or the default) can starve
// a healthy blocking read.
const SOCKET_TIMEOUT_FLOOR_MS = 2_000

// Reconnect backoff cap (ms). The default reconnectStrategy caps at 2000ms; keep
// that so a long outage retries at a steady ~2s cadence rather than backing off
// into minutes (we WANT to reconnect promptly the instant redis returns).
const RECONNECT_MAX_DELAY_MS = 2_000

// A reconnect strategy that ALWAYS returns a delay — it never returns `false` or
// an `Error`, so the client can never permanently give up (the bug). Capped
// exponential backoff with jitter to avoid a reconnect thundering-herd across
// hosts. `cause` is logged so a real outage is visible in Grafana/Loki, but it
// never changes the decision: we always retry.
function reconnectStrategy(retries: number, cause: unknown): number {
  const base = Math.min(2 ** retries * 50, RECONNECT_MAX_DELAY_MS)
  const jitter = Math.floor(Math.random() * 250)
  const delay = base + jitter
  // Only log occasionally so a long outage doesn't flood the logs: first few
  // attempts, then every ~16th.
  if (retries < 5 || retries % 16 === 0) {
    log.warn("redis reconnecting", { retries, delayMs: delay, cause: causeMessage(cause) })
  }
  return delay
}

function causeMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message
  }
  return String(cause)
}

// Build a client with resilient socket options + lifecycle logging. `kind`
// distinguishes the shared client from a blocking one — in the logs AND in
// behaviour: pingInterval is only meaningful for the (often-idle) shared client.
function buildClient(kind: "shared" | "blocking"): MeshRedis {
  const label = kind
  const client = createClient({
    url: meshRedisUrl(),
    socket: {
      // Bumped from node-redis' 5s default: a transient slow connect shouldn't
      // be treated as a hard failure. Env-overridable for tuning / tests.
      connectTimeout: envInt("AGENT_MESH_REDIS_CONNECT_TIMEOUT_MS", 10_000),
      // CRITICAL: node-redis' connectTimeout ONLY covers the TCP-connect phase —
      // it removes the timeout the instant the socket emits 'connect', so the
      // HELLO/AUTH handshake AND all steady-state reads run with NO timeout. A
      // half-open / blackholed connection (TCP up, server silent) therefore hangs
      // FOREVER, parking the blocking XREAD and wedging the daemon — even with a
      // good reconnect strategy, because the strategy never gets a chance to fire.
      // socketTimeout arms a socket inactivity timeout AFTER connect: if no bytes
      // flow for this long the socket is destroyed (SocketTimeoutError), which our
      // reconnectStrategy turns into a retry. Must comfortably exceed both the
      // XREAD BLOCK interval (~1s) and the pingInterval so a healthy idle socket
      // is never killed; the periodic PING keeps an otherwise-idle shared client
      // active well within this window.
      socketTimeout: envInt("AGENT_MESH_REDIS_SOCKET_TIMEOUT_MS", 30_000, SOCKET_TIMEOUT_FLOOR_MS),
      keepAlive: true,
      keepAliveInitialDelay: envInt("AGENT_MESH_REDIS_KEEPALIVE_MS", 5_000),
      reconnectStrategy,
    },
    // Proactively PING while idle to surface a half-open connection (one that
    // silently dropped) so node-redis tears it down and reconnects. Only useful
    // on the SHARED client: the blocking client runs XREAD BLOCK in a tight loop
    // and is never idle, so a queued PING is redundant and — being queued BEHIND
    // a hung XREAD — can't detect that hang anyway. socketTimeout is the blocking
    // client's protection for that case.
    ...(kind === "shared" ? { pingInterval: envInt("AGENT_MESH_REDIS_PING_INTERVAL_MS", 10_000) } : {}),
  })
  // An 'error' listener is MANDATORY: without one, node-redis re-emits socket
  // errors as uncaught 'error' events that crash the process. We log and let the
  // reconnectStrategy do its job — never exit here.
  client.on("error", (error) => {
    process.stderr.write(`[agent-mesh] redis (${label}) error: ${(error as Error).message}\n`)
  })
  client.on("reconnecting", () => log.warn("redis client reconnecting", { label }))
  client.on("ready", () => log.info("redis client ready", { label }))
  client.on("end", () => log.warn("redis client connection ended", { label }))
  return client
}

// Intentional process-lifetime singleton: the daemon is a single long-lived
// process that owns ONE Redis connection for the whole host (that's the design —
// agents reach Redis only through this daemon). This is not request-scoped state.
let shared: Promise<MeshRedis> | null = null

export async function getMeshRedis(): Promise<MeshRedis> {
  if (shared != null) {
    return shared
  }
  shared = (async () => {
    const client = buildClient("shared")
    await client.connect()
    return client
  })()
  return shared
}

// Drop the shared singleton (closing it if still open) so the next getMeshRedis()
// builds a fresh one. The daemon's watchdog calls this if the shared client ever
// ends up permanently closed — defense-in-depth on top of the reconnect strategy.
export async function resetMeshRedis(): Promise<void> {
  if (shared == null) {
    return
  }
  const pending = shared
  shared = null
  try {
    const client = await pending
    if (client.isOpen) {
      await client.close()
    }
  } catch {
    /* best-effort — the point is just to discard the old client */
  }
}

export async function createMeshBlockingClient(): Promise<MeshRedis> {
  const client = buildClient("blocking")
  await client.connect()
  return client
}

export async function closeMeshRedis(): Promise<void> {
  if (shared == null) {
    return
  }
  const client = await shared
  shared = null
  if (client.isOpen) {
    await client.close()
  }
}
