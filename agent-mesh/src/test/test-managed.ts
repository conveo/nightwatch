import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { randomUUID } from "node:crypto"
import { ManagedScheduler } from "../managed-scheduler.js"
import { endpointSchema, managedTransportSchema } from "../managed-delivery.js"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selectDelivery, adapterCommand, runCommand, verifyEndpoint, processStarted } from "../managed-delivery.js"
import { appendToInbox, readUnread } from "../local-store.js"
import { Wakeups } from "../wakeups.js"
import type { MeshMessage } from "../types.js"

export async function runManagedTest(): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "mesh-managed-"))
  const previous = process.env.AGENT_MESH_HOME
  process.env.AGENT_MESH_HOME = home
  try {
    const neither = await selectDelivery({ endpoint: null, env: {}, monitor: false, owner: null, dedicated: false })
    assert.equal(neither.type, "polling")
    const monitor = await selectDelivery({ endpoint: null, env: {}, monitor: true, owner: null, dedicated: false })
    assert.equal(monitor.type, "monitor")
    const ambiguous = await selectDelivery({
      endpoint: null,
      env: { SUPERSET_WORKSPACE_ID: "w", HERDR_ENV: "1" },
      monitor: true,
      owner: null,
      dedicated: false,
    })
    assert.equal(ambiguous.reason, "address-ambiguous")
    const endpoint = { type: "superset" as const, host: "h", workspace: "w", terminal: "t" }
    const cmd = adapterCommand({ endpoint, notification: "quotes ' \"\n$(touch nope)" })
    assert.deepEqual(cmd.args, [
      "terminals",
      "send",
      "--host",
      "h",
      "--workspace",
      "w",
      "--terminal",
      "t",
      "--text",
      "quotes ' \"\n$(touch nope)",
      "--json",
    ])
    const owner = { runtime: "codex" as const, session: "native-session", pid: process.pid, started: processStarted(process.pid)! }
    const herdr = { type: "herdr" as const, socket: "/tmp/isolated.sock", pane: "w2D:p7" }
    for (const pane of ["w1:p1", "w2D:p7", "w2D:pA", "w2d:pa"]) {
      const expected = { ...herdr, pane }
      assert.deepEqual(endpointSchema.parse(expected), expected)
      const selected = await selectDelivery({
        endpoint: null,
        env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: herdr.socket, HERDR_PANE_ID: pane },
        monitor: false,
        owner,
        dedicated: true,
        verify: async ({ endpoint }) => {
          assert.deepEqual(endpoint, expected)
          return { reason: "verified-dedicated-agent", terminal: "terminal" }
        },
      })
      assert.deepEqual(selected, { type: "adapter", endpoint: expected, reason: "verified-dedicated-agent" })
    }
    for (const pane of [
      "session-name",
      "w2D:t7",
      "w:p7",
      "w2D:p",
      "w2D:p7:extra",
      "--current",
      "w2D:p7\n",
      "w2D:p7;echo unsafe",
    ]) {
      assert.equal(endpointSchema.safeParse({ ...herdr, pane }).success, false)
    }
    for (const runtime of ["claude", "codex"] as const) {
      for (const [status, reason] of [
        ["idle", "verified-dedicated-agent"],
        ["working", "busy"],
        ["blocked", "blocked"],
        ["unknown", "unknown"],
      ]) {
        const run: typeof runCommand = async ({ command }) => ({
          outcome: "ok",
          reason: "mock",
          stdout: JSON.stringify(
            command.args[0] === "agent"
              ? {
                  result: {
                    type: "agent_info",
                    agent: {
                      pane_id: herdr.pane,
                      terminal_id: "terminal",
                      agent: runtime,
                      agent_status: status,
                      interactive_ready: true,
                      launch_pending: false,
                      agent_session: { agent: runtime, kind: "id", value: owner.session },
                    },
                  },
                }
              : {
                  result: {
                    type: "pane_process_info",
                    process_info: { pane_id: herdr.pane, foreground_processes: [{ pid: process.pid, name: runtime }] },
                  },
                },
          ),
        })
        assert.equal((await verifyEndpoint({ endpoint: herdr, owner: { ...owner, runtime }, run })).reason, reason)
      }
    }
    const omittedReadiness: typeof runCommand = async ({ command }) => ({
      outcome: "ok",
      reason: "mock",
      stdout: JSON.stringify(
        command.args[0] === "agent"
          ? {
              result: {
                type: "agent_info",
                agent: {
                  pane_id: herdr.pane,
                  terminal_id: "terminal",
                  agent: owner.runtime,
                  agent_status: "idle",
                  agent_session: { agent: owner.runtime, kind: "id", value: owner.session },
                },
              },
            }
          : {
              result: {
                type: "pane_process_info",
                process_info: { pane_id: herdr.pane, foreground_processes: [{ pid: process.pid, name: owner.runtime }] },
              },
            },
      ),
    })
    assert.equal(
      (await verifyEndpoint({ endpoint: herdr, owner, run: omittedReadiness })).reason,
      "verified-dedicated-agent",
    )
    assert.equal((await verifyEndpoint({ endpoint: herdr, owner: { ...owner, started: "old" } })).reason, "owner-changed")
    assert.equal((await selectDelivery({ endpoint: herdr, env: {}, monitor: true, owner, dedicated: false })).reason, "dedicated-required")
    assert.equal(
      (await selectDelivery({ endpoint: null, env: { HERDR_ENV: "1" }, monitor: true, owner, dedicated: true })).reason,
      "unconfigured",
    )
    assert.equal(
      (
        await selectDelivery({
          endpoint: herdr,
          env: { SUPERSET_WORKSPACE_ID: "nested" },
          monitor: true,
          owner,
          dedicated: true,
          verify: async () => ({ reason: "verified-dedicated-agent", terminal: "t" }),
        })
      ).type,
      "adapter",
    )
    assert.equal(
      (
        await selectDelivery({
          endpoint: herdr,
          env: {},
          monitor: true,
          owner,
          dedicated: true,
          verify: async () => ({ reason: "unavailable", terminal: null }),
        })
      ).type,
      "unavailable",
    )
    const data = "quote' \"\n$(echo wrong)"
    const argv = await runCommand({
      command: { bin: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", data], env: process.env },
      timeoutMs: 1000,
    })
    assert.equal(argv.stdout, data)
    assert.equal((await runCommand({ command: { bin: "/nonexistent/mesh-test", args: [], env: {} }, timeoutMs: 100 })).outcome, "not-sent")
    assert.equal(
      (await runCommand({ command: { bin: process.execPath, args: ["-e", "setTimeout(()=>{},10000)"], env: {} }, timeoutMs: 50 })).outcome,
      "ambiguous",
    )
    assert.equal(
      (
        await runCommand({
          command: { bin: process.execPath, args: ["-e", "process.stderr.write('agent_blocked');process.exit(1)"], env: {} },
          timeoutMs: 1000,
        })
      ).reason,
      "blocked",
    )
    const wakeups = new Wakeups()
    const message = (id: string): MeshMessage => ({
      id,
      ts: new Date().toISOString(),
      channel: "inbox:a",
      from: "b",
      to: "a",
      type: "request",
      body: { text: id },
      correlationId: "thread",
      replyTo: "parent",
    })
    appendToInbox("a", message("1"))
    appendToInbox("a", message("1"))
    assert.equal(readUnread("a", { peek: true }).length, 1)
    const batch = wakeups.claim({ id: "a", generation: "g", now: 1 })!
    appendToInbox("a", message("2"))
    assert.equal(wakeups.claim({ id: "a", generation: "g", now: 2 })?.token, batch.token)
    assert.throws(() => wakeups.ack({ id: "a", generation: "old", token: batch.token, now: 3 }))
    wakeups.ack({ id: "a", generation: "g", token: batch.token, now: 4 })
    assert.deepEqual(
      new Wakeups().claim({ id: "a", generation: "g", now: 5 })?.messages.map((m) => m.id),
      ["2"],
    )
    assert.equal(readUnread("a", { peek: true }).length, 2)
    // A failed directory flush must be retried even when the message bytes are
    // already visible; deduplication must not turn an unflushed append into success.
    const originalFsync = fs.fsyncSync
    let failDirectory = true
    let directoryFlushed = false
    try {
      fs.fsyncSync = (fd) => {
        if (fs.fstatSync(fd).isDirectory()) {
          if (failDirectory) throw new Error("injected directory flush failure")
          directoryFlushed = true
        }
        originalFsync(fd)
      }
      syncBuiltinESMExports()
      assert.throws(() => appendToInbox("flush-retry", message("flush")), /directory flush failure/)
      failDirectory = false
      appendToInbox("flush-retry", message("flush"))
      assert.equal(directoryFlushed, true)
      assert.equal(readUnread("flush-retry", { peek: true }).length, 1)
    } finally {
      fs.fsyncSync = originalFsync
      syncBuiltinESMExports()
    }
    wakeups.bind({ id: "clock", generation: "clock-generation", now: 0, tickMs: 1000 })
    wakeups.tick({ id: "clock", generation: "clock-generation", now: 100000, tickMs: 1000 })
    const clockBatch = new Wakeups().claim({ id: "clock", generation: "clock-generation", now: 100001 })!
    assert.equal(clockBatch.tick, 1000)
    assert.equal(clockBatch.messages.length, 0)
    wakeups.update({ id: "clock", generation: "clock-generation", token: clockBatch.token, patch: { outcome: "sending" } })
    new Wakeups().restore("clock")
    assert.equal(wakeups.state("clock")?.batch?.outcome, "ambiguous")
    wakeups.retire("clock")
    wakeups.tick({ id: "clock", generation: "clock-generation", now: 999999, tickMs: 1000 })
    assert.equal(wakeups.state("clock")?.nextTick, null)
    assert.equal(
      wakeups.update({ id: "clock", generation: "clock-generation", token: clockBatch.token, patch: { outcome: "submitted" } }),
      false,
    )
    let releaseSlow: () => void = () => {
      throw new Error("slow probe not initialized")
    }
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    let probes = 0
    let sends = 0
    const scheduler = new ManagedScheduler({
      verify: async ({ endpoint }) => {
        probes++
        if (endpoint.type === "herdr" && endpoint.pane === "w2:p1") await slow
        return { reason: "verified-dedicated-agent", terminal: "terminal" }
      },
      run: async () => {
        sends++
        return { outcome: "ok", reason: "mock-success", stdout: "" }
      },
    })
    const recipients = Array.from({ length: 7 }, (_, i) => ({
      id: `parallel-${i}`,
      transport: managedTransportSchema.parse({
        type: "managed",
        generation: randomUUID(),
        owner,
        selection: { type: "adapter", endpoint: { ...herdr, pane: `w2:p${i + 1}` }, reason: "verified-dedicated-agent" },
        tickMs: null,
      }),
    }))
    for (const recipient of recipients) {
      scheduler.wakeups.bind({ id: recipient.id, generation: recipient.transport.generation, now: 0, tickMs: null })
      appendToInbox(recipient.id, message("parallel"))
      const batch = scheduler.wakeups.claim({ id: recipient.id, generation: recipient.transport.generation, now: 0 })!
      scheduler.wakeups.update({
        id: recipient.id,
        generation: recipient.transport.generation,
        token: batch.token,
        patch: { nextAttempt: 0 },
      })
      scheduler.schedule({ ...recipient, owns: async () => true })
    }
    assert.equal(recipients.filter((r) => scheduler.busy(r.id)).length, 4)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(probes, 4)
    for (const recipient of recipients) scheduler.schedule({ ...recipient, owns: async () => true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sends, 6)
    assert.equal(probes, 7)
    assert.equal(scheduler.busy(recipients[0].id), true)
    // A callback cannot mutate a new binding's pending batch.
    scheduler.wakeups.bind({ id: recipients[0].id, generation: "replacement", now: 0, tickMs: null })
    releaseSlow()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sends, 6)
    assert.equal(scheduler.wakeups.state(recipients[0].id)?.generation, "replacement")
    // A long-running turn must eventually receive mail without an operator retry.
    let working = true
    let workingSends = 0
    const workingScheduler = new ManagedScheduler({
      verify: async () => ({ reason: working ? "busy" : "verified-dedicated-agent", terminal: "terminal" }),
      run: async () => {
        workingSends++
        return { outcome: "ok", reason: "mock-success", stdout: "" }
      },
    })
    const recipient = recipients[1]
    workingScheduler.wakeups.bind({ id: recipient.id, generation: recipient.transport.generation, now: 0, tickMs: null })
    const workingBatch = workingScheduler.wakeups.claim({ id: recipient.id, generation: recipient.transport.generation, now: 0 })!
    for (let attempt = 0; attempt < 10; attempt++) {
      workingScheduler.wakeups.update({
        id: recipient.id,
        generation: recipient.transport.generation,
        token: workingBatch.token,
        patch: { nextAttempt: 0 },
      })
      workingScheduler.schedule({ ...recipient, owns: async () => true })
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(workingScheduler.wakeups.state(recipient.id)?.batch?.outcome, "pending")
    assert.equal(workingSends, 0)
    working = false
    workingScheduler.wakeups.update({
      id: recipient.id,
      generation: recipient.transport.generation,
      token: workingBatch.token,
      patch: { nextAttempt: 0 },
    })
    workingScheduler.schedule({ ...recipient, owns: async () => true })
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(workingSends, 1)
    console.log("  [PASS] managed selection, argv, deduplication, restart, receipt range fencing")
    return 0
  } finally {
    if (previous == null) delete process.env.AGENT_MESH_HOME
    else process.env.AGENT_MESH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

if (process.argv[1]?.endsWith("test-managed.ts"))
  runManagedTest().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
