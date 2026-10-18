import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { Endpoint, Owner, Probe, runCommand } from "./managed-delivery.js"

type SupersetEndpoint = Extract<Endpoint, { type: "superset" }>
const bindingSchema = z.object({
  terminalId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  agentSessionId: z.string(),
  startedAt: z.number(),
  lastEventAt: z.number(),
  lastEventType: z.string(),
})
type Binding = z.infer<typeof bindingSchema>
type Connection =
  | { type: "connected"; host: string; binding: (endpoint: SupersetEndpoint) => Promise<Binding | null> }
  | { type: "unavailable"; reason: "unavailable" | "unconfigured" | "unsupported" }
type ProcessOwner = {
  runtime: string
  workspace: string
  terminal: string
  started: string
  foreground: boolean
  suggestionsDisabled: boolean
}
export type SupersetDependencies = {
  connect: () => Promise<Connection>
  process: (pid: number) => Promise<ProcessOwner | null>
  screen: (endpoint: SupersetEndpoint) => Promise<{ terminalId: string; text: string } | null>
}
const execute = promisify(execFile)
const statusSchema = z.object({
  running: z.literal(true),
  healthy: z.literal(true),
  hostId: z.string(),
  organizationId: z.string().uuid(),
  pid: z.number(),
  endpoint: z.string(),
})
const manifestSchema = z.object({ pid: z.number(), endpoint: z.string(), authToken: z.string().min(1), organizationId: z.string().uuid() })

// Only a local service discovered by the CLI may receive this local token.
// Reject redirects before fetching: a changed manifest must not forward it.
export function localServiceUrl(endpoint: string): URL {
  const url = new URL(endpoint)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("not a local Superset service")
  return url
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || response.body == null) throw new Error("Superset metadata unavailable")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 65536) throw new Error("Superset metadata output limit")
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } finally {
    await reader.cancel()
  }
}

export async function connectSuperset({ run, directory }: { run: typeof runCommand; directory: string }): Promise<Connection> {
  const status = await run({ command: { bin: "superset", args: ["status", "--json"], env: { ...process.env } }, timeoutMs: 5000 })
  if (status.outcome !== "ok") return { type: "unavailable", reason: status.reason === "unsupported" ? "unsupported" : "unavailable" }
  try {
    const info = statusSchema.parse(JSON.parse(status.stdout))
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory, info.organizationId, "manifest.json"), "utf8")))
    if (manifest.pid !== info.pid || manifest.endpoint !== info.endpoint || manifest.organizationId !== info.organizationId)
      return { type: "unavailable", reason: "unavailable" }
    const base = localServiceUrl(manifest.endpoint)
    return {
      type: "connected",
      host: info.hostId,
      binding: async (endpoint) => {
        const url = new URL("/trpc/terminalAgents.listByWorkspace", base)
        url.searchParams.set("input", JSON.stringify({ json: { workspaceId: endpoint.workspace } }))
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${manifest.authToken}` },
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        })
        const wire = z.object({ result: z.object({ data: z.object({ json: z.array(z.unknown()) }) }) }).parse(await boundedJson(response))
        const matches = wire.result.data.json.filter(
          (value) => value != null && typeof value === "object" && "terminalId" in value && value.terminalId === endpoint.terminal,
        )
        return matches.length === 1 ? bindingSchema.parse(matches[0]) : null
      },
    }
  } catch {
    // Return a reason, never the manifest or response: both may contain private data.
    return { type: "unavailable", reason: "unconfigured" }
  }
}

// Inspect the actual runtime's inherited endpoint and controlling terminal.
// Raw process environments remain inside this helper and are never returned/logged.
export async function supersetProcess(pid: number): Promise<ProcessOwner | null> {
  if (process.platform !== "darwin" && process.platform !== "linux") return null
  try {
    const options = { timeout: 3000, maxBuffer: 1024 * 1024, encoding: "utf8" as const }
    const meta = await execute("ps", ["-p", String(pid), "-o", "pgid=,tpgid=,tty=,lstart=,comm="], options)
    const match = meta.stdout.trim().match(/^(\d+)\s+(-?\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/)
    if (match == null || match[3] === "?" || match[3] === "??") return null
    const runtime = match[5].split("/").pop()!
    if (runtime !== "claude" && runtime !== "codex") return null
    let values: Record<string, string> = {}
    if (process.platform === "linux") {
      const environment = await readFile(`/proc/${pid}/environ`, "utf8")
      values = Object.fromEntries(
        environment.split("\0").flatMap((entry) => {
          const index = entry.indexOf("=")
          return index > 0 ? [[entry.slice(0, index), entry.slice(index + 1)]] : []
        }),
      )
    } else {
      const environment = await execute("ps", ["eww", "-p", String(pid), "-o", "command="], options)
      for (const key of ["SUPERSET_WORKSPACE_ID", "SUPERSET_TERMINAL_ID", "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION"]) {
        const matches = [...environment.stdout.matchAll(new RegExp(`(?:^| )${key}=([^ ]*)`, "g"))]
        values[key] = matches.at(-1)?.[1] ?? ""
      }
    }
    return {
      runtime,
      workspace: values.SUPERSET_WORKSPACE_ID ?? "",
      terminal: values.SUPERSET_TERMINAL_ID ?? "",
      started: match[4],
      foreground: match[1] === match[2],
      suggestionsDisabled: values.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION === "false",
    }
  } catch {
    return null
  }
}

function lastMatchingLine({ lines, pattern }: { lines: string[]; pattern: RegExp }): number {
  for (let index = lines.length - 1; index >= 0; index--) if (pattern.test(lines[index])) return index
  return -1
}

export function classifySupersetScreen({ runtime, text }: { runtime: Owner["runtime"]; text: string }): Probe["reason"] {
  const lines = text.split("\n")
  // Examine the current composer/footer, not older work-order text above it.
  const lastBorder = lastMatchingLine({ lines, pattern: /^─(?:─{9,}| (?:Worked for [\w .]+|Conversation recap) ─{10,})\s*$/ })
  const tail = lines.slice(Math.max(0, lastBorder - 8)).join("\n")
  if (/esc to interrupt|Esc to interrupt|^[·✢✳✶✻✽]\s+.+…(?:\s|$)/m.test(tail)) return "busy"
  if (/Would you like to|Do you want to|Enter to confirm|Esc to cancel|Allow once|Yes, allow/i.test(tail)) return "blocked"
  switch (runtime) {
    case "claude": {
      const prompt = lastMatchingLine({ lines, pattern: /^❯/ })
      if (prompt < 1 || !/^─{10,}\s*$/.test(lines[prompt - 1]) || !/^─{10,}\s*$/.test(lines[prompt + 1] ?? "")) return "unknown"
      return /^❯\s*$/.test(lines[prompt]) ? "verified-dedicated-agent" : "draft-present"
    }
    case "codex": {
      const prompt = lastMatchingLine({ lines, pattern: /^›/ })
      if (prompt <= lastBorder || lastBorder < 0) return "unknown"
      const composer = lines[prompt].slice(1).trim()
      if (composer !== "" && composer !== "Ask Codex to do anything") return "draft-present"
      if ((lines[prompt - 1] ?? "").trim() !== "" || !lines.slice(prompt + 1, -1).every((line) => line.trim() === "")) return "unknown"
      if (!/^\s+\S.* · \S/.test(lines.at(-1) ?? "")) return "unknown"
      return "verified-dedicated-agent"
    }
  }
}
function processMatches({
  process: current,
  endpoint,
  owner,
}: {
  process: ProcessOwner
  endpoint: SupersetEndpoint
  owner: Owner
}): boolean {
  return (
    current.runtime === owner.runtime &&
    current.workspace === endpoint.workspace &&
    current.terminal === endpoint.terminal &&
    current.started === owner.started
  )
}
function bindingMatches({ binding, endpoint, owner }: { binding: Binding; endpoint: SupersetEndpoint; owner: Owner }): boolean {
  return (
    binding.workspaceId === endpoint.workspace &&
    binding.terminalId === endpoint.terminal &&
    binding.agentId === owner.runtime &&
    binding.agentSessionId === owner.session
  )
}
function lifecycle(binding: Binding): Probe["reason"] {
  switch (binding.lastEventType) {
    case "Stop":
      return "verified-dedicated-agent"
    case "Start":
    case "SessionStart":
    case "UserPromptSubmit":
      return "busy"
    case "PermissionRequest":
    case "Notification":
      return "blocked"
    default:
      return "unknown"
  }
}
export async function probeSuperset({
  endpoint,
  owner,
  dependencies,
}: {
  endpoint: SupersetEndpoint
  owner: Owner
  dependencies: SupersetDependencies
}): Promise<Probe> {
  const result = (reason: Probe["reason"]): Probe => ({ reason, terminal: endpoint.terminal })
  try {
    const connection = await dependencies.connect()
    if (connection.type !== "connected") return result(connection.reason)
    if (connection.host !== endpoint.host) return result("owner-changed")
    const current = await dependencies.process(owner.pid)
    if (current == null) return result("unknown")
    if (!processMatches({ process: current, endpoint, owner })) return result("owner-changed")
    if (owner.runtime === "claude" && !current.suggestionsDisabled) return result("prompt-suggestions-enabled")
    const binding = await connection.binding(endpoint)
    if (binding == null || !bindingMatches({ binding, endpoint, owner })) return result("owner-changed")
    const state = lifecycle(binding)
    if (state !== "verified-dedicated-agent") return result(state)
    if (!current.foreground) return result("busy")
    const screen = await dependencies.screen(endpoint)
    if (screen == null || screen.terminalId !== endpoint.terminal) return result("unknown")
    const readiness = classifySupersetScreen({ runtime: owner.runtime, text: screen.text })
    if (readiness !== "verified-dedicated-agent") return result(readiness)
    // Screen read and send are not atomic. Recheck after the slow CLI read;
    // dedicated terminals remain required to constrain the remaining race.
    const latest = await connection.binding(endpoint)
    const process = await dependencies.process(owner.pid)
    if (latest == null || !bindingMatches({ binding: latest, endpoint, owner }) || latest.startedAt !== binding.startedAt)
      return result("owner-changed")
    if (process == null) return result("unknown")
    if (!processMatches({ process, endpoint, owner })) return result("owner-changed")
    if (!process.foreground) return result("busy")
    const latestState = lifecycle(latest)
    if (latestState === "verified-dedicated-agent" && latest.lastEventAt !== binding.lastEventAt) return result("unknown")
    return result(latestState)
  } catch {
    return result("unavailable")
  }
}
export function supersetDependencies(run: typeof runCommand): SupersetDependencies {
  return {
    connect: () => connectSuperset({ run, directory: join(homedir(), ".superset", "host") }),
    process: supersetProcess,
    screen: async (endpoint) => {
      const response = await run({
        command: {
          bin: "superset",
          args: [
            "terminals",
            "read",
            "--host",
            endpoint.host,
            "--workspace",
            endpoint.workspace,
            "--terminal",
            endpoint.terminal,
            "--json",
          ],
          env: { ...process.env },
        },
        timeoutMs: 5000,
      })
      return response.outcome === "ok" ? z.object({ terminalId: z.string(), text: z.string() }).parse(JSON.parse(response.stdout)) : null
    },
  }
}
export async function discoverSuperset({
  env,
  run,
}: {
  env: NodeJS.ProcessEnv
  run: typeof runCommand
}): Promise<{ endpoint: SupersetEndpoint | null; reason: Probe["reason"] }> {
  const workspace = env.SUPERSET_WORKSPACE_ID
  const terminal = env.SUPERSET_TERMINAL_ID
  if (workspace == null || workspace === "" || terminal == null || terminal === "") return { endpoint: null, reason: "unconfigured" }
  const connection = await connectSuperset({ run, directory: join(homedir(), ".superset", "host") })
  return connection.type === "connected"
    ? { endpoint: { type: "superset", host: connection.host, workspace, terminal }, reason: "verified-dedicated-agent" }
    : { endpoint: null, reason: connection.reason }
}

// Claude does not always export a native session ID. Resolve it from Superset's
// own hook binding only after checking the registering runtime's actual endpoint.
export async function supersetNativeSession({
  endpoint,
  runtime,
  pid,
  run,
}: {
  endpoint: SupersetEndpoint
  runtime: Owner["runtime"]
  pid: number
  run: typeof runCommand
}): Promise<string | null> {
  try {
    const connection = await connectSuperset({ run, directory: join(homedir(), ".superset", "host") })
    if (connection.type !== "connected" || connection.host !== endpoint.host) return null
    const process = await supersetProcess(pid)
    if (
      process == null ||
      process.runtime !== runtime ||
      process.workspace !== endpoint.workspace ||
      process.terminal !== endpoint.terminal
    )
      return null
    const binding = await connection.binding(endpoint)
    return binding != null && binding.workspaceId === endpoint.workspace && binding.agentId === runtime ? binding.agentSessionId : null
  } catch {
    return null
  }
}
