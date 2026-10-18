// Manager addresses remain host-local. Neither an environment hint nor a CLI
// success is a receipt; the receiving turn explicitly ACKs a bounded batch.
import { spawn, spawnSync } from "node:child_process"
import { z } from "zod"
import { discoverSuperset, probeSuperset, supersetDependencies } from "./superset-delivery.js"

const address = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("-") && !/[\x00-\x1f]/.test(value))
export const endpointSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("superset"), host: address, workspace: address, terminal: address }),
  z.object({
    type: z.literal("herdr"),
    socket: address.refine((value) => value.startsWith("/")),
    // Herdr handles are alphanumeric (for example w2D:p7), not decimal indices.
    // Preserve the exact handle for native-session and process-owner verification.
    pane: address.regex(/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/),
  }),
])
export type Endpoint = z.infer<typeof endpointSchema>
export const ownerSchema = z.object({
  runtime: z.enum(["claude", "codex"]),
  session: address,
  pid: z.number().int().positive(),
  started: z.string().min(1),
})
export type Owner = z.infer<typeof ownerSchema>
const reasons = z.enum([
  "verified-dedicated-agent",
  "monitor-declared",
  "no-push-endpoint",
  "address-ambiguous",
  "unconfigured",
  "unavailable",
  "unsupported",
  "owner-changed",
  "blocked",
  "busy",
  "unknown",
  "dedicated-required",
  "draft-present",
  "prompt-suggestions-enabled",
])
export const selectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("adapter"), endpoint: endpointSchema, reason: z.literal("verified-dedicated-agent") }),
  z.object({ type: z.literal("unavailable"), endpoint: endpointSchema.nullable(), reason: reasons }),
  z.object({ type: z.literal("monitor"), reason: z.literal("monitor-declared") }),
  z.object({ type: z.literal("polling"), reason: z.literal("no-push-endpoint") }),
])
export type Selection = z.infer<typeof selectionSchema>
export const managedTransportSchema = z.object({
  type: z.literal("managed"),
  generation: z.string().uuid(),
  owner: ownerSchema.nullable(),
  selection: selectionSchema,
  tickMs: z.number().int().min(1000).nullable(),
})
export type ManagedTransport = z.infer<typeof managedTransportSchema>
export type Command = { bin: string; args: string[]; env: NodeJS.ProcessEnv }
export type CommandResult = { outcome: "ok" | "not-sent" | "ambiguous"; reason: string; stdout: string }

export function processStarted(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 })
  return result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null
}

export function adapterCommand({ endpoint, notification }: { endpoint: Endpoint; notification: string }): Command {
  switch (endpoint.type) {
    case "superset":
      return {
        bin: "superset",
        args: [
          "terminals",
          "send",
          "--host",
          endpoint.host,
          "--workspace",
          endpoint.workspace,
          "--terminal",
          endpoint.terminal,
          "--text",
          notification,
          "--json",
        ],
        env: { ...process.env },
      }
    case "herdr":
      return {
        bin: "herdr",
        args: ["agent", "prompt", endpoint.pane, notification],
        env: { ...process.env, HERDR_SOCKET_PATH: endpoint.socket },
      }
  }
}

export async function submitNotification({
  endpoint,
  notification,
  run,
}: {
  endpoint: Endpoint
  notification: string
  run: typeof runCommand
}): Promise<CommandResult> {
  const result = await run({ command: adapterCommand({ endpoint, notification }), timeoutMs: 10000 })
  if (result.outcome !== "ok" || endpoint.type !== "superset") return result
  try {
    z.object({ terminalId: z.literal(endpoint.terminal), submitted: z.literal(true) }).parse(JSON.parse(result.stdout))
    return result
  } catch {
    // Input may already have been written. A malformed/mismatched response
    // requires receipt or inspection, never an automatic duplicate submission.
    return { outcome: "ambiguous", reason: "unexpected-submit-response", stdout: "" }
  }
}

// Output is bounded and never logged verbatim: manager errors can contain
// terminal content, local credentials, or arbitrary user drafts.
export function runCommand({ command, timeoutMs }: { command: Command; timeoutMs: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false
    let stdout = ""
    let stderr = ""
    const child = spawn(command.bin, command.args, { env: command.env, stdio: ["ignore", "pipe", "pipe"] })
    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.removeListener("exit", stopChild)
      resolve(result)
    }
    const stopChild = () => {
      child.kill("SIGKILL")
    }
    process.once("exit", stopChild)
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ outcome: "ambiguous", reason: "timeout", stdout: "" })
    }, timeoutMs)
    child.stdout.on("data", (data) => {
      stdout += data.toString()
      if (stdout.length > 65536) {
        child.kill("SIGKILL")
        finish({ outcome: "ambiguous", reason: "output-limit", stdout: "" })
      }
    })
    child.stderr.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(0, 8192)
    })
    child.on("error", (error) =>
      finish({
        outcome: "not-sent",
        reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "unsupported" : "spawn-error",
        stdout: "",
      }),
    )
    child.on("close", (code) => {
      if (code === 0) return finish({ outcome: "ok", reason: "cli-exit-zero", stdout })
      // Only this documented pre-submission rejection is safe to retry. Other
      // errors may follow a successful write and must wait for human inspection.
      const blocked = /^(?:Error:\s*)?agent_blocked(?:\s|:|$)/m.test(stderr.trim())
      finish({ outcome: blocked ? "not-sent" : "ambiguous", reason: blocked ? "blocked" : `exit-${code}`, stdout: "" })
    })
  })
}

const herdrAgentSchema = z.object({
  pane_id: z.string(),
  terminal_id: z.string(),
  agent: z.string().nullable(),
  agent_status: z.enum(["idle", "working", "blocked", "done", "unknown"]),
  // Herdr declares both on AgentInfo but omits them from `agent get`; requiring
  // them here verifies every idle pane as "unknown" and never selects the adapter.
  interactive_ready: z.boolean().default(true),
  launch_pending: z.boolean().default(false),
  agent_session: z.object({ agent: z.string(), kind: z.string(), value: z.string() }).nullable(),
})
const herdrProcessSchema = z.object({ pane_id: z.string(), foreground_processes: z.array(z.object({ pid: z.number(), name: z.string() })) })
export type Probe = { reason: z.infer<typeof reasons>; terminal: string | null }
// Herdr serializes tagged results such as {result:{type:"agent_info",agent}}. Accepting an
// unrecognized shape must fail closed, never guess at a focused pane.
function responseData(stdout: string): unknown {
  const value = JSON.parse(stdout)
  const result = value.result ?? value
  return result.agent != null && result.type === "agent_info" ? result.agent : (result.process_info ?? result)
}
export async function verifyEndpoint({
  endpoint,
  owner,
  run = runCommand,
}: {
  endpoint: Endpoint
  owner: Owner
  run?: typeof runCommand
}): Promise<Probe> {
  const started = processStarted(owner.pid)
  if (started == null) {
    try {
      process.kill(owner.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return { reason: "owner-changed", terminal: null }
    }
    return { reason: "unknown", terminal: null }
  }
  if (started !== owner.started) return { reason: "owner-changed", terminal: null }
  switch (endpoint.type) {
    case "superset":
      return probeSuperset({ endpoint, owner, dependencies: supersetDependencies(run) })
    case "herdr": {
      const env = { ...process.env, HERDR_SOCKET_PATH: endpoint.socket }
      const agentResult = await run({ command: { bin: "herdr", args: ["agent", "get", endpoint.pane], env }, timeoutMs: 5000 })
      const procResult = await run({
        command: { bin: "herdr", args: ["pane", "process-info", "--pane", endpoint.pane], env },
        timeoutMs: 5000,
      })
      if (agentResult.outcome !== "ok" || procResult.outcome !== "ok") return { reason: "unavailable", terminal: null }
      try {
        const agent = herdrAgentSchema.parse(responseData(agentResult.stdout))
        const proc = herdrProcessSchema.parse(responseData(procResult.stdout))
        if (
          agent.pane_id !== endpoint.pane ||
          proc.pane_id !== endpoint.pane ||
          agent.agent !== owner.runtime ||
          agent.agent_session?.agent !== owner.runtime ||
          agent.agent_session.kind !== "id" ||
          agent.agent_session.value !== owner.session ||
          !proc.foreground_processes.some((p) => p.pid === owner.pid && p.name === owner.runtime)
        )
          return { reason: "owner-changed", terminal: null }
        switch (agent.agent_status) {
          case "blocked":
            return { reason: "blocked", terminal: agent.terminal_id }
          case "working":
            return { reason: "busy", terminal: agent.terminal_id }
          case "unknown":
            return { reason: "unknown", terminal: agent.terminal_id }
          case "done":
          case "idle":
            return {
              reason: agent.interactive_ready && !agent.launch_pending ? "verified-dedicated-agent" : "unknown",
              terminal: agent.terminal_id,
            }
        }
      } catch {
        return { reason: "unknown", terminal: null }
      }
    }
  }
}

export async function selectDelivery({
  endpoint,
  env,
  monitor,
  owner,
  dedicated,
  verify = verifyEndpoint,
  discover = discoverSuperset,
}: {
  endpoint: Endpoint | null
  env: NodeJS.ProcessEnv
  monitor: boolean
  owner: Owner | null
  dedicated: boolean
  verify?: typeof verifyEndpoint
  discover?: typeof discoverSuperset
}): Promise<Selection> {
  let target = endpoint
  if (target == null) {
    const superset = [env.SUPERSET_WORKSPACE_ID, env.SUPERSET_TERMINAL_ID, env.SUPERSET_TAB_ID].some((v) => v != null && v !== "")
    const herdr = [env.HERDR_ENV, env.HERDR_SOCKET_PATH, env.HERDR_PANE_ID].some((v) => v != null && v !== "")
    if (superset && herdr) return { type: "unavailable", endpoint: null, reason: "address-ambiguous" }
    if (superset) {
      const detected = await discover({ env, run: runCommand })
      if (detected.endpoint == null) return { type: "unavailable", endpoint: null, reason: detected.reason }
      target = endpointSchema.parse(detected.endpoint)
    }
    if (herdr) {
      const parsed = endpointSchema.safeParse({ type: "herdr", socket: env.HERDR_SOCKET_PATH, pane: env.HERDR_PANE_ID })
      if (!parsed.success) return { type: "unavailable", endpoint: null, reason: "unconfigured" }
      target = parsed.data
    }
  }
  if (target == null) return monitor ? { type: "monitor", reason: "monitor-declared" } : { type: "polling", reason: "no-push-endpoint" }
  if (owner == null) return { type: "unavailable", endpoint: target, reason: "owner-changed" }
  if (!dedicated) return { type: "unavailable", endpoint: target, reason: "dedicated-required" }
  const result = await verify({ endpoint: target, owner })
  // Working/blocked owners can bind, but submission is deferred by the daemon
  // until an idle, verified agent is observed. No runtime busy-input guessing.
  if (["verified-dedicated-agent", "busy", "blocked"].includes(result.reason))
    return { type: "adapter", endpoint: target, reason: "verified-dedicated-agent" }
  return { type: "unavailable", endpoint: target, reason: result.reason }
}
