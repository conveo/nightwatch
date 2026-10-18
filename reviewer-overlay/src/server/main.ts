import { execFile } from "node:child_process"
import { join } from "node:path"
import { ConfigError, parseConfig, USAGE } from "./config.ts"
import { createMeshCliPublisher } from "./publish.ts"
import { startServer } from "./server.ts"

const clientDir = join(import.meta.dirname, "..", "..", "dist")

let config
try {
  // `pnpm overlay` runs this from reviewer-overlay/; pnpm sets INIT_CWD to the
  // directory the command was typed in, which is where relative paths belong.
  const cwd = process.env.INIT_CWD != null && process.env.INIT_CWD !== "" ? process.env.INIT_CWD : process.cwd()
  const parsed = parseConfig({ argv: process.argv.slice(2), env: process.env, cwd })
  if (parsed === "help") {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  config = parsed
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`reviewer-overlay: ${message}\n\n${error instanceof ConfigError ? USAGE : ""}`)
  process.exit(2)
}

const publisher = createMeshCliPublisher({
  command: config.meshCommand,
  timeoutMs: config.publishTimeoutMs,
  exec: null,
})

const server = await startServer({ config, publisher, clientDir, now: () => new Date() })
const base = `http://127.0.0.1:${config.port}`
process.stdout.write(
  [
    `reviewer-overlay listening on ${base}`,
    `  add to your app:  <script src="${base}/reviewer-overlay.js" defer></script>`,
    `  allowed origins:  ${config.origins.join(", ")}`,
    `  notes go to:      ${config.targetAgentId} (sent as ${config.reporterId})`,
    `  test plan:        ${config.planPath}`,
    `  reports:          ${config.reportDir}`,
    "",
  ].join("\n"),
)

// A daemon that is down only shows up on the first send otherwise.
const [file, ...prefix] = config.meshCommand
if (file != null) {
  execFile(file, [...prefix, "health"], { timeout: 15_000 }, (error, _stdout, stderr) => {
    if (error != null) {
      const lastLine = stderr.trim().split("\n").pop() ?? ""
      const detail = lastLine === "" ? error.message : lastLine
      process.stderr.write(`reviewer-overlay: warning: \`agent-mesh health\` failed (${detail}). Notes will not be delivered until the daemon is up.\n`)
    }
  })
}

const stop = () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
