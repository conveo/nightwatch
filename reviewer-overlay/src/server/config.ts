import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { agentIdSchema } from "../contract.ts"
import { parseCommand } from "./publish.ts"

export type ServerConfig = {
  port: number
  origins: string[]
  targetAgentId: string
  reporterId: string
  allowTargetOverride: boolean
  planPath: string
  reportDir: string
  meshCommand: string[]
  publishTimeoutMs: number
  maxBodyBytes: number
  allowedHosts: string[]
}

export const USAGE = `Usage: node src/server/main.ts --origin <url> --target <agent-id> [options]

Required:
  --origin <url>           Dev origin of your app, e.g. http://localhost:3000.
                           Repeat for more than one. Env: REVIEWER_OVERLAY_ORIGINS (comma-separated)
  --target <agent-id>      Agent that receives the notes. Env: REVIEW_TARGET_AGENT_ID

Options:
  --port <n>               Port on 127.0.0.1 (default 4848). Env: REVIEWER_OVERLAY_PORT
  --reporter-id <id>       Mesh id the notes are sent from (default reviewer-overlay)
  --plan <path>            Test plan JSON (default untracked/review-plan.json)
  --report-dir <path>      Where screenshots and report copies go
                           (default untracked/review-overlay-report)
  --mesh-cli <command>     agent-mesh CLI command (default agent-mesh). A JSON
                           array keeps arguments with spaces. Env: REVIEWER_OVERLAY_MESH_CLI
  --publish-timeout-ms <n> Publish timeout (default 15000)
  --max-body-mb <n>        Request size cap in MiB (default 32)
  --allow-host <name>      Extra Host header name to accept (loopback names are
                           always accepted). Repeatable.
  --allow-target-override  Send to the agent id typed in the overlay instead of
                           --target. Off by default: with it, any script on an
                           allowed origin can send notes to any agent id.
  --help                   Show this help
`

export class ConfigError extends Error {}

function normalizeOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`--origin ${value} is not a URL`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`--origin ${value} must be http or https`)
  }
  if (url.origin !== value.replace(/\/$/, "")) {
    throw new ConfigError(`--origin ${value} must be an origin only (no path, query or user info)`)
  }
  return url.origin
}

function positiveInt(args: { name: string; value: string | undefined; fallback: number }): number {
  if (args.value == null) {
    return args.fallback
  }
  const parsed = Number(args.value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`--${args.name} must be a positive integer`)
  }
  return parsed
}

function agentId(args: { name: string; value: string }): string {
  if (!agentIdSchema.safeParse(args.value).success) {
    throw new ConfigError(`--${args.name} must match [A-Za-z0-9._-]{1,128}`)
  }
  return args.value
}

export function parseConfig(args: {
  argv: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}): ServerConfig | "help" {
  const { values } = parseArgs({
    args: args.argv,
    strict: true,
    allowPositionals: false,
    options: {
      origin: { type: "string", multiple: true },
      target: { type: "string" },
      port: { type: "string" },
      "reporter-id": { type: "string" },
      plan: { type: "string" },
      "report-dir": { type: "string" },
      "mesh-cli": { type: "string" },
      "publish-timeout-ms": { type: "string" },
      "max-body-mb": { type: "string" },
      "allow-host": { type: "string", multiple: true },
      "allow-target-override": { type: "boolean" },
      help: { type: "boolean" },
    },
  })
  if (values.help === true) {
    return "help"
  }

  const rawOrigins =
    values.origin ??
    (args.env.REVIEWER_OVERLAY_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== "")
  if (rawOrigins.length === 0) {
    throw new ConfigError("at least one --origin is required")
  }

  const target = values.target ?? args.env.REVIEW_TARGET_AGENT_ID
  if (target == null || target === "") {
    throw new ConfigError("--target is required")
  }

  const port = positiveInt({
    name: "port",
    value: values.port ?? args.env.REVIEWER_OVERLAY_PORT,
    fallback: 4848,
  })
  if (port > 65_535) {
    throw new ConfigError("--port must be at most 65535")
  }

  let meshCommand: string[]
  try {
    meshCommand = parseCommand(values["mesh-cli"] ?? args.env.REVIEWER_OVERLAY_MESH_CLI ?? "agent-mesh")
  } catch (error) {
    throw new ConfigError(`--mesh-cli: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    port,
    origins: [...new Set(rawOrigins.map(normalizeOrigin))],
    targetAgentId: agentId({ name: "target", value: target }),
    reporterId: agentId({
      name: "reporter-id",
      value: values["reporter-id"] ?? args.env.REVIEWER_OVERLAY_REPORTER_ID ?? "reviewer-overlay",
    }),
    allowTargetOverride: values["allow-target-override"] === true,
    planPath: resolve(args.cwd, values.plan ?? "untracked/review-plan.json"),
    reportDir: resolve(args.cwd, values["report-dir"] ?? "untracked/review-overlay-report"),
    meshCommand,
    publishTimeoutMs: positiveInt({
      name: "publish-timeout-ms",
      value: values["publish-timeout-ms"],
      fallback: 15_000,
    }),
    maxBodyBytes:
      positiveInt({ name: "max-body-mb", value: values["max-body-mb"], fallback: 32 }) * 1024 * 1024,
    allowedHosts: (values["allow-host"] ?? []).map((host) => host.toLowerCase()),
  }
}
