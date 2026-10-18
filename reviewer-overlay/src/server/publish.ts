import { execFile } from "node:child_process"
import { CORRELATION_ID, MESSAGE_TYPE } from "../contract.ts"

export type PublishArgument = {
  from: string
  to: string
  body: Record<string, unknown>
}

export type PublishResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string }

export type Publisher = (argument: PublishArgument) => Promise<PublishResult>

type ExecResult = {
  error: (Error & { code?: unknown; killed?: boolean }) | null
  stdout: string
  stderr: string
}

export type Exec = (args: {
  file: string
  args: string[]
  timeoutMs: number
}) => Promise<ExecResult>

const defaultExec: Exec = ({ file, args, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({ error, stdout, stderr })
      },
    )
  })

// Splits `--mesh-cli`. A JSON array keeps paths with spaces intact; a plain
// string splits on whitespace. No shell is involved either way.
export function parseCommand(value: string): string[] {
  const trimmed = value.trim()
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed)
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((part) => typeof part === "string" && part !== "")
    ) {
      throw new Error("mesh CLI must be a non-empty JSON array of strings")
    }
    return parsed
  }
  const parts = trimmed.split(/\s+/).filter((part) => part !== "")
  if (parts.length === 0) {
    throw new Error("mesh CLI command is empty")
  }
  return parts
}

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  return (lines[lines.length - 1] ?? "").slice(0, 300)
}

// Publishes through the agent-mesh CLI. Success is the `published <id> -> <to>`
// line on stdout, not the exit code: the CLI has exited 0 without publishing
// (an unknown flag on older builds), so a zero exit alone proves nothing.
export function createMeshCliPublisher(args: {
  command: string[]
  timeoutMs: number
  exec: Exec | null
}): Publisher {
  const [file, ...prefix] = args.command
  if (file == null) {
    throw new Error("mesh CLI command is empty")
  }
  const exec = args.exec ?? defaultExec
  return async ({ from, to, body }) => {
    const result = await exec({
      file,
      args: [
        ...prefix,
        "publish",
        "--id",
        from,
        "--to",
        to,
        "--type",
        MESSAGE_TYPE,
        "--corr",
        CORRELATION_ID,
        "--body",
        JSON.stringify(body),
      ],
      timeoutMs: args.timeoutMs,
    })
    if (result.error != null) {
      if (result.error.killed === true) {
        return { ok: false, error: `agent-mesh publish timed out after ${args.timeoutMs} ms` }
      }
      const detail = lastLine(result.stderr) || result.error.message
      return { ok: false, error: `agent-mesh publish failed: ${detail}` }
    }
    for (const line of result.stdout.split("\n")) {
      const match = /^published (\S+) -> (\S+) /.exec(line.trim())
      if (match?.[1] != null && match[2] === to) {
        return { ok: true, messageId: match[1] }
      }
    }
    const detail = lastLine(result.stderr) || lastLine(result.stdout) || "no output"
    return {
      ok: false,
      error: `agent-mesh did not confirm the publish (no "published <id>" line): ${detail}`,
    }
  }
}
