import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selectDelivery, submitNotification } from "../managed-delivery.js"
import { classifySupersetScreen, probeSuperset, connectSuperset, localServiceUrl, type SupersetDependencies } from "../superset-delivery.js"

const endpoint = { type: "superset" as const, host: "local-host", workspace: "workspace", terminal: "terminal" }
const owner = { runtime: "codex" as const, session: "native", pid: 123, started: "start" }
const binding = {
  terminalId: "terminal",
  workspaceId: "workspace",
  agentId: "codex",
  agentSessionId: "native",
  startedAt: 1,
  lastEventAt: 2,
  lastEventType: "Stop",
}
const codexScreen = "• RECEIVED token\n\n────────────────────\n \n› Ask Codex to do anything\n \n  gpt-6-astra high · /scratch"
const claudeScreen = "⏺ RECEIVED token\n\n────────────────────\n❯ \n────────────────────\n  ⏵⏵ auto mode on"

export async function runSupersetTest(): Promise<number> {
  let failures = 0
  const check = async (name: string, test: () => Promise<void> | void) => {
    try {
      await test()
      console.log(`  [PASS] ${name}`)
    } catch (error) {
      failures++
      console.error(`  [FAIL] ${name}`, error)
    }
  }
  const dependencies = (overrides: Partial<SupersetDependencies> = {}): SupersetDependencies => ({
    connect: async () => ({ type: "connected", host: "local-host", binding: async () => binding }),
    process: async () => ({
      runtime: "codex",
      workspace: "workspace",
      terminal: "terminal",
      started: "start",
      foreground: true,
      suggestionsDisabled: true,
    }),
    screen: async () => ({ terminalId: "terminal", text: codexScreen }),
    ...overrides,
  })
  await check("Superset admits only recognized dedicated idle composers", () => {
    assert.equal(classifySupersetScreen({ runtime: "codex", text: codexScreen }), "verified-dedicated-agent")
    assert.equal(classifySupersetScreen({ runtime: "claude", text: claudeScreen }), "verified-dedicated-agent")
    assert.equal(
      classifySupersetScreen({
        runtime: "codex",
        text: codexScreen.replace("────────────────────", "─ Worked for 1m 01s ────────────────────"),
      }),
      "verified-dedicated-agent",
    )
    assert.equal(
      classifySupersetScreen({
        runtime: "codex",
        text: codexScreen.replace("────────────────────", "─ Conversation recap ────────────────────\n\n  Previous work is complete."),
      }),
      "verified-dedicated-agent",
    )
    assert.equal(
      classifySupersetScreen({ runtime: "claude", text: claudeScreen.replace("⏺ RECEIVED token", "· Sock-hopping… (21s · ↓ 744 tokens)") }),
      "busy",
    )
    for (const runtime of ["claude", "codex"] as const) {
      assert.equal(classifySupersetScreen({ runtime, text: "$ " }), "unknown")
      assert.equal(classifySupersetScreen({ runtime, text: "Would you like to run the following command?\n1. Yes\n2. No" }), "blocked")
    }
    assert.equal(classifySupersetScreen({ runtime: "claude", text: claudeScreen.replace("❯ ", "❯ a human draft") }), "draft-present")
    assert.equal(
      classifySupersetScreen({ runtime: "codex", text: codexScreen.replace("Ask Codex to do anything", "a human draft") }),
      "draft-present",
    )
    assert.equal(classifySupersetScreen({ runtime: "codex", text: codexScreen + "\n  esc to interrupt" }), "busy")
    assert.equal(
      classifySupersetScreen({
        runtime: "codex",
        text: "────────────────────\n\n  Update Model Permissions\n\n› 2. Approve for me (current)\n\n  Press enter to confirm or esc to go back",
      }),
      "blocked",
    )
  })
  await check("Superset verifies native owner, endpoint and foreground process", async () => {
    assert.equal((await probeSuperset({ endpoint, owner, dependencies: dependencies() })).reason, "verified-dedicated-agent")
    for (const override of [{ runtime: "claude" }, { terminal: "replacement" }, { workspace: "other" }, { started: "new" }]) {
      assert.equal(
        (
          await probeSuperset({
            endpoint,
            owner,
            dependencies: dependencies({
              process: async () => ({
                runtime: "codex",
                workspace: "workspace",
                terminal: "terminal",
                started: "start",
                foreground: true,
                suggestionsDisabled: true,
                ...override,
              }),
            }),
          })
        ).reason,
        "owner-changed",
      )
    }
    assert.equal((await probeSuperset({ endpoint, owner, dependencies: dependencies({ process: async () => null }) })).reason, "unknown")
    assert.equal(
      (
        await probeSuperset({
          endpoint,
          owner: { ...owner, runtime: "claude" },
          dependencies: dependencies({
            process: async () => ({
              runtime: "claude",
              workspace: "workspace",
              terminal: "terminal",
              started: "start",
              foreground: true,
              suggestionsDisabled: false,
            }),
          }),
        })
      ).reason,
      "prompt-suggestions-enabled",
    )
    assert.equal(
      (await probeSuperset({ endpoint: { ...endpoint, host: "remote" }, owner, dependencies: dependencies() })).reason,
      "owner-changed",
    )
    for (const [lastEventType, reason] of [
      ["Start", "busy"],
      ["PermissionRequest", "blocked"],
      ["new-event", "unknown"],
    ]) {
      assert.equal(
        (
          await probeSuperset({
            endpoint,
            owner,
            dependencies: dependencies({
              connect: async () => ({ type: "connected", host: "local-host", binding: async () => ({ ...binding, lastEventType }) }),
            }),
          })
        ).reason,
        reason,
      )
    }
    assert.equal(
      (
        await probeSuperset({
          endpoint,
          owner,
          dependencies: dependencies({
            connect: async () => ({
              type: "connected",
              host: "local-host",
              binding: async () => ({ ...binding, agentSessionId: "replaced" }),
            }),
          }),
        })
      ).reason,
      "owner-changed",
    )
  })
  await check("Superset rechecks ownership after screen inspection", async () => {
    let reads = 0
    let screens = 0
    const result = await probeSuperset({
      endpoint,
      owner,
      dependencies: dependencies({
        connect: async () => ({
          type: "connected",
          host: "local-host",
          binding: async () => (++reads === 1 ? binding : { ...binding, agentSessionId: "new" }),
        }),
        screen: async () => {
          screens++
          return { terminalId: "terminal", text: codexScreen }
        },
      }),
    })
    assert.equal(result.reason, "owner-changed")
    assert.equal(screens, 1)
  })
  await check("Superset auto selection verifies markers and preserves configured failures", async () => {
    const base = {
      endpoint: null,
      env: { SUPERSET_WORKSPACE_ID: "workspace", SUPERSET_TERMINAL_ID: "terminal" },
      monitor: true,
      owner,
      dedicated: true,
      discover: async () => ({ endpoint, reason: "verified-dedicated-agent" as const }),
      verify: async () => ({ reason: "verified-dedicated-agent" as const, terminal: "terminal" }),
    }
    assert.equal((await selectDelivery(base)).type, "adapter")
    assert.equal((await selectDelivery({ ...base, endpoint, env: { HERDR_ENV: "nested" } })).type, "adapter")
    assert.equal((await selectDelivery({ ...base, env: { ...base.env, HERDR_ENV: "nested" } })).reason, "address-ambiguous")
    assert.equal((await selectDelivery({ ...base, dedicated: false })).reason, "dedicated-required")
    assert.equal((await selectDelivery({ ...base, verify: async () => ({ reason: "unavailable", terminal: null }) })).type, "unavailable")
    assert.equal(
      (await selectDelivery({ ...base, discover: async () => ({ endpoint: null, reason: "unconfigured" }) })).reason,
      "unconfigured",
    )
    assert.equal((await selectDelivery({ ...base, env: {}, monitor: false })).type, "polling")
  })
  await check("Superset submission requires a matching explicit submission response", async () => {
    for (const [stdout, outcome] of [
      [JSON.stringify({ terminalId: endpoint.terminal, submitted: true }), "ok"],
      [JSON.stringify({ terminalId: "other", submitted: true }), "ambiguous"],
      [JSON.stringify({ terminalId: endpoint.terminal, submitted: false }), "ambiguous"],
      ["{}", "ambiguous"],
      ["not JSON", "ambiguous"],
    ]) {
      const result = await submitNotification({
        endpoint,
        notification: "fixed-envelope",
        run: async () => ({ outcome: "ok", reason: "cli-exit-zero", stdout }),
      })
      assert.equal(result.outcome, outcome)
    }
  })
  await check("local metadata lookup bounds responses and never follows credential redirects", async () => {
    for (const url of [
      "https://example.com",
      "http://127.0.0.1.example.com",
      "http://user:password@127.0.0.1",
      "http://127.0.0.1/path",
      "http://127.0.0.1?other=1",
    ])
      assert.throws(() => localServiceUrl(url))
    const directory = mkdtempSync(join(tmpdir(), "mesh-superset-metadata-"))
    const organizationId = "11111111-1111-4111-8111-111111111111"
    const authToken = randomUUID()
    let mode = "ok"
    let requests = 0
    const server = createServer((req, res) => {
      requests++
      assert.equal(req.headers.authorization, `Bearer ${authToken}`)
      assert.equal(new URL(req.url!, "http://localhost").pathname, "/trpc/terminalAgents.listByWorkspace")
      if (mode === "redirect") {
        res.writeHead(302, { Location: "/do-not-follow" })
        res.end()
        return
      }
      if (mode === "oversized") {
        res.end("x".repeat(70000))
        return
      }
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ result: { data: { json: [binding] } } }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      assert.ok(address != null && typeof address !== "string")
      const endpointUrl = `http://127.0.0.1:${address.port}`
      mkdirSync(join(directory, organizationId))
      writeFileSync(
        join(directory, organizationId, "manifest.json"),
        JSON.stringify({ pid: 123, endpoint: endpointUrl, authToken, organizationId }),
      )
      const connection = await connectSuperset({
        directory,
        run: async ({ command }) => {
          assert.deepEqual(command.args, ["status", "--json"])
          return {
            outcome: "ok",
            reason: "mock",
            stdout: JSON.stringify({ running: true, healthy: true, hostId: "local-host", organizationId, pid: 123, endpoint: endpointUrl }),
          }
        },
      })
      assert.equal(connection.type, "connected")
      if (connection.type !== "connected") throw new Error("expected connection")
      assert.deepEqual(await connection.binding(endpoint), binding)
      mode = "redirect"
      await assert.rejects(connection.binding(endpoint))
      assert.equal(requests, 2, "redirect must not receive a second authenticated request")
      mode = "oversized"
      await assert.rejects(connection.binding(endpoint))
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error != null ? reject(error) : resolve())))
      rmSync(directory, { recursive: true, force: true })
    }
  })
  return failures
}
if (process.argv[1]?.endsWith("test-superset.ts")) process.exitCode = (await runSupersetTest()) > 0 ? 1 : 0
