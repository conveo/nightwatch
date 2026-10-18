// Minimal structured logger for the agent-mesh daemon/CLI. It emits a single
// timestamped JSON line per record so the
// daemon's output is greppable in Loki/journald. No app dependency — this is a
// self-contained package.

type Level = "debug" | "info" | "warn" | "error"

function emit(level: Level, message: string, ctx?: Record<string, unknown>): void {
  const record = { ts: new Date().toISOString(), level, message, ...(ctx ?? {}) }
  const line = JSON.stringify(record, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v))
  // warn/error to stderr, the rest to stdout
  if (level === "warn" || level === "error") {
    process.stderr.write(`${line}\n`)
  } else {
    process.stdout.write(`${line}\n`)
  }
}

export const log = {
  debug: (message: string, ctx?: Record<string, unknown>) => emit("debug", message, ctx),
  info: (message: string, ctx?: Record<string, unknown>) => emit("info", message, ctx),
  warn: (message: string, ctx?: Record<string, unknown>) => emit("warn", message, ctx),
  error: (message: string, ctx?: Record<string, unknown>) => emit("error", message, ctx),
}
