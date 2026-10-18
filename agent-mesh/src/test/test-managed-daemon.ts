import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { call, daemonClient } from "../daemon-client.js"
import { processStarted } from "../managed-delivery.js"
import type { Batch } from "../wakeups.js"
import type { MeshMessage } from "../types.js"

const source = dirname(dirname(fileURLToPath(import.meta.url)))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error("managed test condition timed out")
}

export async function runManagedDaemonTest(): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "mesh-bound-"))
  const previousSocket = process.env.AGENT_MESH_SOCK
  const sock = join(home, "daemon.sock")
  process.env.AGENT_MESH_SOCK = sock
  const fake = join(home, "herdr")
  const state = join(home, "mock-state")
  const submissions = join(home, "submissions")
  writeFileSync(state, "idle")
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs=require('fs'); const a=process.argv.slice(2); const state=fs.readFileSync(${JSON.stringify(state)},'utf8');
const runtime=a.includes('w1:p2')?'claude':'codex'; const pane=runtime==='claude'?'w1:p2':'w1:p1';
const agent={pane_id:pane,terminal_id:'terminal',agent:runtime,agent_status:state==='failed'?'idle':state,interactive_ready:true,launch_pending:false,agent_session:{agent:runtime,kind:'id',value:'native-test'}};
if(a[0]==='agent'&&a[1]==='get') console.log(JSON.stringify({result:{type:'agent_info',agent}}));
else if(a[0]==='pane') console.log(JSON.stringify({result:{type:'pane_process_info',process_info:{pane_id:pane,foreground_processes:[{pid:${process.pid},name:runtime}]}}}));
else if(a[1]==='prompt') { if(state==='failed'){console.error('agent_blocked');process.exit(1)} fs.appendFileSync(${JSON.stringify(submissions)},JSON.stringify(a)+'\\n');console.log('{}') }
`,
  )
  chmodSync(fake, 0o755)
  const launch = () =>
    spawn("tsx", [join(source, "daemon.ts")], {
      env: {
        ...process.env,
        PATH: `${home}:${process.env.PATH}`,
        AGENT_MESH_HOME: home,
        AGENT_MESH_HOSTNAME: "bound-test",
        AGENT_MESH_PREFIX: `bound-test-${process.pid}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
  const stop = async (child: ChildProcess) => {
    child.kill("SIGTERM")
    await new Promise((resolve) => child.once("exit", resolve))
    await sleep(100)
  }
  let storageFailed = false
  let daemon = launch()
  daemon.stderr?.on("data", (data) => {
    if (data.toString().includes("routeMessage failed; retaining cursor for retry")) storageFailed = true
    if (process.env.AGENT_MESH_DEBUG === "1") process.stderr.write(data)
  })
  try {
    await until(async () => {
      try {
        return (await daemonClient.health()).ok
      } catch {
        return false
      }
    })
    const id = `actor-${randomUUID()}`
    const input = {
      id,
      role: "orchestrator",
      owner: { runtime: "codex", session: "native-test", pid: process.pid, started: processStarted(process.pid) },
      endpoint: { type: "herdr", socket: "/tmp/mock-only.sock", pane: "w1:p1" },
      monitor: false,
      dedicated: true,
      hints: {},
      expectedGeneration: null,
      tickMs: 5000,
    }
    const bound = await call<{ deliver: { generation: string } }>("POST", "/bind", input)
    // A failed durable inbox write must not advance past the message. Repair
    // only this disposable actor's path and prove automatic broker retry.
    const brokenPath = join(home, "inbox", `${id}.jsonl`)
    mkdirSync(brokenPath)
    await daemonClient.publish({ from: "publisher", to: id, type: "note", body: { storageRetry: true } })
    await until(async () => storageFailed)
    await stop(daemon)
    rmSync(brokenPath, { recursive: true })
    // Simulate a crash-partial write with the message still pending in Redis.
    // Restart must replay it once, preserving the original rich message.
    writeFileSync(brokenPath, '{"id":')
    daemon = launch()
    await until(async () => {
      try {
        return (await daemonClient.health()).ok
      } catch {
        return false
      }
    })
    const generation = bound.deliver.generation
    const inspect = () => call<any>("GET", `/delivery?id=${id}`)
    const receive = () => call<{ batch: (Batch & { messages: MeshMessage[] }) | null }>("GET", `/receive?id=${id}&generation=${generation}`)
    await until(async () => (await daemonClient.inbox(id, { peek: true })).some((message) => message.body.storageRetry === true))
    const storageBatch = (await receive()).batch!
    await call("POST", "/receipt", { id, generation, token: storageBatch.token })
    // A second host/home cannot claim or legacy-register this actor.
    const otherHome = mkdtempSync(join(tmpdir(), "mesh-other-host-"))
    const otherSocket = join(otherHome, "daemon.sock")
    const other = spawn("tsx", [join(source, "daemon.ts")], {
      env: {
        ...process.env,
        AGENT_MESH_HOME: otherHome,
        AGENT_MESH_SOCK: otherSocket,
        AGENT_MESH_HOSTNAME: "other-host",
        AGENT_MESH_PREFIX: `bound-test-${process.pid}`,
      },
      stdio: "ignore",
    })
    try {
      process.env.AGENT_MESH_SOCK = otherSocket
      await until(async () => {
        try {
          return (await daemonClient.health()).ok
        } catch {
          return false
        }
      })
      await assert.rejects(() => call("POST", "/bind", input), /owned elsewhere/)
      await assert.rejects(() => daemonClient.register({ id, role: "intruder" }), /binding/)
    } finally {
      process.env.AGENT_MESH_SOCK = sock
      await stop(other)
      rmSync(otherHome, { recursive: true, force: true })
    }
    await daemonClient.register({ id, role: "refresh", meta: { session: "native-test" } })
    assert.equal((await inspect()).transport.generation, generation)
    await assert.rejects(() => call("POST", "/bind", { ...input, id: `duplicate-${id}` }), /endpoint already bound/)
    await assert.rejects(() => call("POST", "/bind", input), /rebind/)
    await assert.rejects(() => daemonClient.register({ id, role: "x" }), /binding/)
    await assert.rejects(() => daemonClient.watchPeek(id), /watch disabled/)
    const beforeBurst = existsSync(submissions) ? readFileSync(submissions, "utf8").trim().split("\n").length : 0
    for (let i = 0; i < 3; i++)
      await daemonClient.publish({
        from: "publisher",
        to: id,
        type: "request",
        body: { commentId: `comment-${i}`, anchor: { text: "selected text", image: "s3-key" } },
        correlationId: "plan-thread",
        replyTo: "parent",
      })
    await until(async () => (await inspect()).state?.batch?.outcome === "submitted")
    const batch = (await receive()).batch!
    // The scheduler may freeze a batch between HTTP publishes. Messages arriving
    // after that boundary must remain in the next batch, in publisher order.
    assert.ok(batch.messages.length >= 1 && batch.messages.length <= 3)
    for (const message of batch.messages) {
      assert.equal(message.correlationId, "plan-thread")
      assert.equal(message.replyTo, "parent")
    }
    assert.equal(readFileSync(submissions, "utf8").trim().split("\n").length, beforeBurst + 1)
    assert.equal(readFileSync(submissions, "utf8").includes("selected text"), false)
    await daemonClient.publish({ from: "publisher", to: id, type: "note", body: { late: true } })
    await until(async () => (await daemonClient.inbox(id, { peek: true })).length === 5)
    await call("POST", "/receipt", { id, generation, token: batch.token })
    assert.equal((await receive()).batch?.messages.length, 4 - batch.messages.length)
    await assert.rejects(() => call("POST", "/receipt", { id, generation: randomUUID(), token: batch.token }), /stale/)
    let late = (await receive()).batch!
    assert.deepEqual(
      [...batch.messages, ...late.messages].map((message) => message.body.commentId ?? "late"),
      ["comment-0", "comment-1", "comment-2", "late"],
    )
    await call("POST", "/receipt", { id, generation, token: late.token })
    await until(async () => (await receive()).batch?.tick != null)
    const tick = (await receive()).batch!
    assert.equal(tick.messages.length, 0)
    await call("POST", "/receipt", { id, generation, token: tick.token })
    assert.equal((await inspect()).tickReady, true)
    // A definite CLI rejection remains pending across restart.
    writeFileSync(state, "failed")
    await daemonClient.publish({ from: "publisher", to: id, type: "note", body: { retry: true } })
    await until(async () => (await inspect()).state?.batch?.reason === "blocked")
    await stop(daemon)
    writeFileSync(state, "idle")
    daemon = launch()
    await until(async () => {
      try {
        return (await inspect()).state?.batch?.outcome === "submitted"
      } catch {
        return false
      }
    })
    late = (await receive()).batch!
    await call("POST", "/receipt", { id, generation, token: late.token })
    // Rebind after an old callback settled, preserving all legacy unread mail.
    await sleep(300)
    let replacement: any
    await until(async () => {
      try {
        replacement = await call("POST", "/bind", { ...input, expectedGeneration: generation, tickMs: null })
        return true
      } catch (error) {
        if (!String(error).includes("in flight")) throw error
        return false
      }
    })
    assert.notEqual(replacement.deliver.generation, generation)
    await assert.rejects(() => call("POST", "/receipt", { id, generation, token: late.token }), /stale/)
    assert.equal((await daemonClient.inbox(id, { peek: true })).length, 6)
    await until(async () => {
      try {
        await call("POST", "/retire", { id, generation: replacement.deliver.generation })
        return true
      } catch (error) {
        if (!String(error).includes("in flight")) throw error
        return false
      }
    })
    assert.equal((await daemonClient.inbox(id, { peek: true })).length, 6)
    assert.equal(existsSync(join(home, "inbox", `${id}.jsonl`)), true)
    await stop(daemon)
    daemon = launch()
    await until(async () => {
      try {
        return (await daemonClient.health()).ok
      } catch {
        return false
      }
    })
    assert.equal((await daemonClient.health()).localAgents.includes(id), false)
    console.log(
      "  [PASS] managed daemon: coalescing, review context, submission/receipt, late mail, clock-only tick, retry/restart, rebind/retire",
    )
    return 0
  } finally {
    if (daemon.exitCode == null) await stop(daemon)
    if (previousSocket == null) delete process.env.AGENT_MESH_SOCK
    else process.env.AGENT_MESH_SOCK = previousSocket
    rmSync(home, { recursive: true, force: true })
  }
}
if (process.argv[1]?.endsWith("test-managed-daemon.ts"))
  runManagedDaemonTest().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
