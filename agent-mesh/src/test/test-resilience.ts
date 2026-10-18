// Isolated integration test for daemon redis-resilience (the 2026-06-13 incident).
//
// Proves the daemon AUTO-RECOVERS from a transient redis outage with NO message
// loss and NO manual restart:
//   (a) the daemon PROCESS survives a ~30s redis outage (health stays ok);
//   (b) messages published DURING and AFTER the outage are delivered once redis
//       recovers;
//   (c) the stream consumer resumes from the correct cursor — no lost messages,
//       no re-delivery of pre-outage messages;
//   (d) recovery is AUTOMATIC within a bounded time after redis returns.
//
// SAFETY: this test NEVER touches the host's live daemon or the shared/production
// redis. It spins up its OWN throwaway redis (docker, ephemeral port), its own
// daemon (isolated home + socket + key prefix), and an in-process TCP fault-proxy
// it controls. The "outage" is injected at the proxy (blackhole — accept the TCP
// connection but never forward, so the daemon's connectTimeout fires a
// SocketTimeoutError, the EXACT cause node-redis' default strategy gives up on).
//
//   pnpm --dir agent-mesh test:resilience
//
// CI-safe: if docker is unavailable it prints SKIP and exits 0.

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createServer, connect, type Server, type Socket } from "node:net"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "redis"
import { daemonClient } from "../daemon-client.js"
import type { MeshMessage } from "../types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++
  }
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
}

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" })
  return r.status === 0
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr != null ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

// A TCP proxy with a flip-able fault mode. Healthy: forwards 127.0.0.1:listenPort
// -> 127.0.0.1:upstreamPort. Faulted: existing connections are severed and new
// ones are BLACKHOLED (accepted, never connected upstream) so the client's
// connectTimeout fires a SocketTimeoutError — the precise disconnect cause that
// node-redis' default reconnectStrategy gives up on permanently.
class FaultProxy {
  private server: Server | null = null
  private pairs = new Set<{ client: Socket; upstream: Socket | null }>()
  faulted = false

  constructor(
    private listenPort: number,
    private upstreamPort: number,
  ) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((client) => {
        const pair: { client: Socket; upstream: Socket | null } = { client, upstream: null }
        this.pairs.add(pair)
        client.on("error", () => {})
        client.on("close", () => this.pairs.delete(pair))
        if (this.faulted) {
          // Blackhole: keep the socket open but never wire it upstream.
          return
        }
        const upstream = connect(this.upstreamPort, "127.0.0.1")
        pair.upstream = upstream
        upstream.on("error", () => client.destroy())
        upstream.on("close", () => client.destroy())
        client.pipe(upstream)
        upstream.pipe(client)
      })
      server.on("error", reject)
      server.listen(this.listenPort, "127.0.0.1", () => resolve())
      this.server = server
    })
  }

  fault(): void {
    this.faulted = true
    for (const pair of this.pairs) {
      pair.upstream?.destroy()
      pair.client.destroy()
    }
    this.pairs.clear()
  }

  heal(): void {
    this.faulted = false
  }

  async stop(): Promise<void> {
    this.fault()
    await new Promise<void>((resolve) => {
      if (this.server == null) {
        resolve()
        return
      }
      this.server.close(() => resolve())
    })
  }
}

async function waitForDaemon(timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await daemonClient.health()).ok) {
        return true
      }
    } catch {
      /* not up yet */
    }
    await sleep(150)
  }
  return false
}

async function daemonHealthy(): Promise<boolean> {
  try {
    return (await daemonClient.health()).ok === true
  } catch {
    return false
  }
}

function deliveredLines(file: string): MeshMessage[] {
  if (!existsSync(file)) {
    return []
  }
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as MeshMessage)
}

export async function runResilienceTest(): Promise<number> {
  console.log("\n== daemon redis-resilience (isolated stack: docker redis + fault-proxy) ==")

  if (!dockerAvailable()) {
    console.log("  [SKIP] docker not available — skipping resilience integration test (CI-safe)")
    return 0
  }

  const prefix = `meshtest_resil_${process.pid}`
  const container = `mesh-resil-${process.pid}`
  const redisPort = await getFreePort()
  const proxyPort = await getFreePort()
  const home = mkdtempSync(join(tmpdir(), "agent-mesh-resil-"))
  const sock = join(home, "daemon.sock")
  const deliveredFile = join(home, "recv-delivered.jsonl")

  let daemon: ChildProcess | null = null
  let proxy: FaultProxy | null = null
  let direct: ReturnType<typeof createClient> | null = null

  // Point the daemon client at our isolated socket for the whole test.
  process.env.AGENT_MESH_SOCK = sock

  try {
    // 1. throwaway redis
    console.log(`  starting throwaway redis (docker ${container} :${redisPort})…`)
    const run = spawnSync("docker", ["run", "--rm", "-d", "--name", container, "-p", `127.0.0.1:${redisPort}:6379`, "redis:7-alpine"], {
      encoding: "utf8",
    })
    if (run.status !== 0) {
      console.log(`  [SKIP] could not start docker redis — ${(run.stderr ?? "").trim().slice(0, 200)}`)
      return 0
    }

    // wait for redis to accept connections (direct client, bypassing the proxy)
    direct = createClient({ url: `redis://127.0.0.1:${redisPort}` })
    direct.on("error", () => {})
    let redisUp = false
    for (let i = 0; i < 60 && !redisUp; i++) {
      try {
        if (!direct.isOpen) {
          await direct.connect()
        }
        await direct.ping()
        redisUp = true
      } catch {
        await sleep(500)
      }
    }
    check("throwaway redis reachable", redisUp)
    if (!redisUp) {
      return failures
    }

    // 2. fault proxy in front of redis
    proxy = new FaultProxy(proxyPort, redisPort)
    await proxy.start()

    // 3. isolated daemon, pointed at the PROXY (so we can sever its redis link).
    //    Short timeouts make the reconnect/recovery fast and deterministic.
    daemon = spawn("tsx", [join(__dirname, "..", "daemon.ts")], {
      env: {
        ...process.env,
        AGENT_MESH_HOME: home,
        AGENT_MESH_SOCK: sock,
        AGENT_MESH_HOSTNAME: "resil-test",
        AGENT_MESH_PREFIX: prefix,
        AGENT_MESH_REDIS_URL: `redis://127.0.0.1:${proxyPort}`,
        AGENT_MESH_REDIS_CONNECT_TIMEOUT_MS: "2000",
        // socketTimeout > XREAD BLOCK (1s) and > pingInterval (1s) so a healthy
        // idle socket is never killed, but a blackholed handshake/read is torn
        // down fast enough to make recovery deterministic within the test budget.
        AGENT_MESH_REDIS_SOCKET_TIMEOUT_MS: "3000",
        AGENT_MESH_REDIS_PING_INTERVAL_MS: "1000",
        AGENT_MESH_REDIS_KEEPALIVE_MS: "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    daemon.stderr?.on("data", (d) => process.env.AGENT_MESH_DEBUG === "1" && process.stderr.write(`[daemon] ${d}`))
    daemon.stdout?.on("data", (d) => process.env.AGENT_MESH_DEBUG === "1" && process.stderr.write(`[daemon] ${d}`))

    check("daemon came up", await waitForDaemon(10_000))

    // register a receiver that records DIRECT deliveries to a file
    await daemonClient.register({ id: "recv", role: "x", deliver: { type: "file", path: deliveredFile } })

    // 4. baseline: a message before the outage is delivered (advances the cursor)
    await daemonClient.publish({ from: "sender", to: "recv", type: "note", body: { seq: 1 } })
    let pre = false
    for (let i = 0; i < 40 && !pre; i++) {
      pre = deliveredLines(deliveredFile).some((m) => (m.body as { seq?: number }).seq === 1)
      if (!pre) {
        await sleep(150)
      }
    }
    check("pre-outage message #1 delivered (baseline)", pre)

    // 5. INJECT OUTAGE — sever the daemon's redis link and blackhole reconnects
    console.log("  injecting redis outage (proxy fault)…")
    proxy.fault()
    const outageStart = Date.now()

    // publish DURING the outage from a remote sender (direct to redis, bypassing
    // the daemon's broken link) — this lands in the stream while the daemon is down
    await direct.xAdd(
      `${prefix}:inbox:recv`,
      "*",
      { ts: new Date().toISOString(), from: "sender", to: "recv", type: "note", body: JSON.stringify({ seq: 2 }), correlationId: "", replyTo: "" },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10_000 } },
    )

    // the daemon PROCESS must stay alive throughout (~32s outage). Health is over
    // the unix socket, independent of redis.
    const OUTAGE_MS = 32_000
    let aliveSamples = 0
    let aliveOk = 0
    while (Date.now() - outageStart < OUTAGE_MS) {
      aliveSamples++
      if (await daemonHealthy()) {
        aliveOk++
      }
      await sleep(2_000)
    }
    check("daemon process survives the entire outage (health ok throughout)", aliveOk === aliveSamples, `${aliveOk}/${aliveSamples} healthy`)

    // message #2 must NOT have been delivered while redis was unreachable
    check("during-outage message #2 not yet delivered (redis unreachable)", !deliveredLines(deliveredFile).some((m) => (m.body as { seq?: number }).seq === 2))

    // 6. RESTORE redis
    console.log("  healing redis (proxy pass-through)…")
    proxy.heal()
    const healAt = Date.now()

    // publish AFTER recovery from a remote sender
    await direct.xAdd(
      `${prefix}:inbox:recv`,
      "*",
      { ts: new Date().toISOString(), from: "sender", to: "recv", type: "note", body: JSON.stringify({ seq: 3 }), correlationId: "", replyTo: "" },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10_000 } },
    )

    // 7. within a bounded time, BOTH the during-outage and after-outage messages
    //    must arrive — AUTOMATICALLY, no restart.
    const RECOVERY_BUDGET_MS = 25_000
    let recovered = false
    while (Date.now() - healAt < RECOVERY_BUDGET_MS && !recovered) {
      const seqs = deliveredLines(deliveredFile).map((m) => (m.body as { seq?: number }).seq)
      recovered = seqs.includes(2) && seqs.includes(3)
      if (!recovered) {
        await sleep(500)
      }
    }
    const recoveryMs = Date.now() - healAt
    check("auto-recovers: during+after messages delivered after redis returns", recovered, `within ${recoveryMs}ms`)
    check("recovery was automatic (no restart) and bounded", recovered && recoveryMs < RECOVERY_BUDGET_MS)
    check("daemon still healthy after recovery", await daemonHealthy())

    // 8. no message loss, no duplicate, correct cursor resume
    const finalSeqs = deliveredLines(deliveredFile).map((m) => (m.body as { seq?: number }).seq)
    check("exactly 3 messages delivered (no loss, no duplicate)", finalSeqs.length === 3, `seqs=[${finalSeqs.join(",")}]`)
    check("delivered in stream order 1,2,3 (cursor resumed correctly)", finalSeqs.join(",") === "1,2,3", `seqs=[${finalSeqs.join(",")}]`)

    // --- regression: a per-message DELIVERY failure (appendToInbox throwing) must
    // NOT kill the delivery loop. We force the failure deterministically by placing
    // a DIRECTORY where the agent's inbox file should be, so appendFileSync throws
    // EISDIR (uid-independent — works even as root, unlike chmod). The loop must
    // survive, skip the un-appendable message, advance its cursor, and keep
    // delivering once the obstruction is removed.
    const recv2Inbox = join(home, "inbox", "recv2.jsonl")
    mkdirSync(recv2Inbox, { recursive: true }) // obstruct the inbox path BEFORE registering
    await daemonClient.register({ id: "recv2", role: "x", deliver: { type: "none" } })
    await sleep(300)
    await direct.xAdd(
      `${prefix}:inbox:recv2`,
      "*",
      { ts: new Date().toISOString(), from: "sender", to: "recv2", type: "note", body: JSON.stringify({ seq: 100 }), correlationId: "", replyTo: "" },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10_000 } },
    )
    await sleep(3_000) // give the loop time to hit the failure (and NOT die)
    check("daemon survives a per-message delivery failure (appendToInbox throws)", await daemonHealthy())

    // remove the obstruction; a later message must still be delivered (loop alive)
    rmSync(recv2Inbox, { recursive: true, force: true })
    await direct.xAdd(
      `${prefix}:inbox:recv2`,
      "*",
      { ts: new Date().toISOString(), from: "sender", to: "recv2", type: "note", body: JSON.stringify({ seq: 101 }), correlationId: "", replyTo: "" },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10_000 } },
    )
    let recovered2 = false
    for (let i = 0; i < 40 && !recovered2; i++) {
      recovered2 = deliveredLines(recv2Inbox).some((m) => (m.body as { seq?: number }).seq === 101)
      if (!recovered2) {
        await sleep(250)
      }
    }
    check("delivery loop keeps working after the failure (later message delivered)", recovered2)
  } finally {
    try {
      daemon?.kill("SIGTERM")
    } catch {
      /* ignore */
    }
    await sleep(300)
    try {
      if (direct?.isOpen) {
        await direct.close()
      }
    } catch {
      /* ignore */
    }
    await proxy?.stop().catch(() => {})
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" })
    rmSync(home, { recursive: true, force: true })
  }

  console.log(`\nresilience: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}

async function main() {
  const f = await runResilienceTest()
  console.log(`\n${"=".repeat(40)}\n${f === 0 ? "✅ RESILIENCE OK" : `❌ ${f} CHECK(S) FAILED`}\n`)
  process.exit(f === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
