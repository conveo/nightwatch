import { readFile, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { join } from "node:path"
import {
  buildMessageBody,
  MAX_MESH_BODY_BYTES,
  planSchema,
  reviewRequestSchema,
  type Plan,
  type ReviewConfigResponse,
  type ReviewPostResponse,
} from "../contract.ts"
import type { ServerConfig } from "./config.ts"
import { decodePngDataUrl } from "./png.ts"
import type { Publisher } from "./publish.ts"
import { ensureReportDir, newReportFiles, overwriteFile, writeNewFile } from "./storage.ts"

const API_PATH = "/api/review"
const MAX_PLAN_BYTES = 1024 * 1024
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"]

const CLIENT_FILES: Record<string, { file: string; type: string }> = {
  "/reviewer-overlay.js": { file: "reviewer-overlay.iife.js", type: "text/javascript; charset=utf-8" },
  "/reviewer-overlay.mjs": { file: "reviewer-overlay.js", type: "text/javascript; charset=utf-8" },
}

export type HandlerDeps = {
  config: ServerConfig
  publisher: Publisher
  clientDir: string
  now: () => Date
}

type Json = Record<string, unknown>

function hostName(header: string | undefined): string | null {
  if (header == null || header === "") {
    return null
  }
  const lower = header.toLowerCase()
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]")
    return end === -1 ? null : lower.slice(0, end + 1)
  }
  return lower.split(":")[0] ?? null
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (origin == null) {
    return { Vary: "Origin" }
  }
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
}

function sendJson(args: {
  res: ServerResponse
  status: number
  body: Json | ReviewConfigResponse | ReviewPostResponse
  corsOrigin: string | null
}): void {
  const text = JSON.stringify(args.body)
  args.res.writeHead(args.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(args.corsOrigin),
  })
  args.res.end(text)
}

function sendError(args: {
  res: ServerResponse
  status: number
  error: string
  message: string
  corsOrigin: string | null
}): void {
  sendJson({
    res: args.res,
    status: args.status,
    body: { ok: false, error: args.error, message: args.message, screenshotPath: null, reportPath: null },
    corsOrigin: args.corsOrigin,
  })
}

type BodyResult = { ok: true; text: string } | { ok: false; reason: "tooLarge" | "aborted" }

function readBody(args: { req: IncomingMessage; maxBytes: number }): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (result: BodyResult) => {
      if (done) {
        return
      }
      done = true
      resolve(result)
    }
    args.req.on("data", (chunk: Buffer) => {
      if (done) {
        return
      }
      size += chunk.length
      if (size > args.maxBytes) {
        chunks.length = 0
        finish({ ok: false, reason: "tooLarge" })
        return
      }
      chunks.push(chunk)
    })
    args.req.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }))
    args.req.on("error", () => finish({ ok: false, reason: "aborted" }))
    args.req.on("aborted", () => finish({ ok: false, reason: "aborted" }))
  })
}

// Close the connection once a refusal is written, so an oversized upload is
// not read to the end.
function refuseAndClose(args: { req: IncomingMessage; res: ServerResponse; corsOrigin: string | null }): void {
  args.res.setHeader("Connection", "close")
  sendError({
    res: args.res,
    status: 413,
    error: "tooLarge",
    message: "The review is larger than the server's size cap.",
    corsOrigin: args.corsOrigin,
  })
  args.res.on("finish", () => args.req.destroy())
}

export async function loadPlan(planPath: string): Promise<{ plan: Plan | null; planError: string | null }> {
  let size: number
  try {
    size = (await stat(planPath)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { plan: null, planError: null }
    }
    return { plan: null, planError: `Cannot read the test plan: ${(error as Error).message}` }
  }
  if (size > MAX_PLAN_BYTES) {
    return { plan: null, planError: "The test plan is larger than 1 MiB." }
  }
  let json: unknown
  try {
    json = JSON.parse(await readFile(planPath, "utf8"))
  } catch (error) {
    return { plan: null, planError: `The test plan is not valid JSON: ${(error as Error).message}` }
  }
  const parsed = planSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue == null ? "" : ` at ${issue.path.join(".") || "(root)"}`
    return { plan: null, planError: `The test plan does not match the schema${where}: ${issue?.message ?? ""}` }
  }
  return { plan: parsed.data, planError: null }
}

function isAllowedPageUrl(args: { value: string; origins: string[] }): boolean {
  let url: URL
  try {
    url = new URL(args.value)
  } catch {
    return false
  }
  return (url.protocol === "http:" || url.protocol === "https:") && args.origins.includes(url.origin)
}

async function handleReviewPost(args: {
  deps: HandlerDeps
  req: IncomingMessage
  res: ServerResponse
  origin: string
}): Promise<void> {
  const { deps, req, res, origin } = args
  const { config } = deps

  const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase()
  if (contentType !== "application/json") {
    sendError({ res, status: 415, error: "unsupportedMediaType", message: "Send application/json.", corsOrigin: origin })
    return
  }
  const declared = Number(req.headers["content-length"] ?? "NaN")
  if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
    refuseAndClose({ req, res, corsOrigin: origin })
    return
  }
  const body = await readBody({ req, maxBytes: config.maxBodyBytes })
  if (!body.ok) {
    if (body.reason === "tooLarge") {
      refuseAndClose({ req, res, corsOrigin: origin })
    }
    return
  }

  let json: unknown
  try {
    json = JSON.parse(body.text)
  } catch {
    sendError({ res, status: 400, error: "invalidBody", message: "The body is not valid JSON.", corsOrigin: origin })
    return
  }
  const parsed = reviewRequestSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue == null || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `
    sendError({
      res,
      status: 400,
      error: "invalidRequest",
      message: `${where}${issue?.message ?? "invalid request"}`,
      corsOrigin: origin,
    })
    return
  }
  const review = parsed.data
  if (!isAllowedPageUrl({ value: review.url, origins: config.origins })) {
    sendError({
      res,
      status: 400,
      error: "invalidUrl",
      message: "The page url must be on an allowed origin.",
      corsOrigin: origin,
    })
    return
  }

  let png: Buffer | null = null
  if (review.screenshotDataUrl != null) {
    const decoded = decodePngDataUrl(review.screenshotDataUrl)
    if (!decoded.ok) {
      sendError({ res, status: 400, error: "invalidScreenshot", message: decoded.reason, corsOrigin: origin })
      return
    }
    png = decoded.buffer
  }

  const target =
    config.allowTargetOverride && review.targetAgentId != null ? review.targetAgentId : config.targetAgentId
  const files = newReportFiles({ dir: config.reportDir, now: deps.now() })
  const screenshotPath = png == null ? null : files.pngPath
  const messageBody = buildMessageBody({ review, screenshotPath, reporterId: config.reporterId })
  if (Buffer.byteLength(JSON.stringify(messageBody)) > MAX_MESH_BODY_BYTES) {
    sendError({
      res,
      status: 413,
      error: "messageTooLarge",
      message: "The note is too large to publish. Shorten the comment or the drawing.",
      corsOrigin: origin,
    })
    return
  }

  const message = {
    type: "note",
    correlationId: "ui-review",
    from: config.reporterId,
    to: target,
    body: messageBody,
  }
  const report = (delivery: Json) =>
    `${JSON.stringify({ id: files.id, savedAt: deps.now().toISOString(), message, delivery }, null, 2)}\n`

  try {
    await ensureReportDir(config.reportDir)
    if (png != null) {
      await writeNewFile({ path: files.pngPath, data: png })
    }
    await writeNewFile({ path: files.jsonPath, data: report({ status: "pending" }) })
  } catch (error) {
    sendError({
      res,
      status: 500,
      error: "saveFailed",
      message: `Could not save the report: ${(error as Error).message}`,
      corsOrigin: origin,
    })
    return
  }

  const published = await deps.publisher({ from: config.reporterId, to: target, body: messageBody })
  await overwriteFile({
    path: files.jsonPath,
    data: report(
      published.ok
        ? { status: "published", meshMessageId: published.messageId }
        : { status: "failed", error: published.error },
    ),
  }).catch(() => {})

  if (!published.ok) {
    sendJson({
      res,
      status: 502,
      body: {
        ok: false,
        error: "publishFailed",
        message: published.error,
        screenshotPath,
        reportPath: files.jsonPath,
      },
      corsOrigin: origin,
    })
    return
  }
  sendJson({
    res,
    status: 200,
    body: {
      ok: true,
      delivered: true,
      meshMessageId: published.messageId,
      targetAgentId: target,
      screenshotPath,
      reportPath: files.jsonPath,
    },
    corsOrigin: origin,
  })
}

async function serveClientFile(args: {
  deps: HandlerDeps
  res: ServerResponse
  entry: { file: string; type: string }
  corsOrigin: string | null
}): Promise<void> {
  let source: Buffer
  try {
    source = await readFile(join(args.deps.clientDir, args.entry.file))
  } catch {
    args.res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
    args.res.end("The client bundle is not built. Run `pnpm build`.\n")
    return
  }
  args.res.writeHead(200, {
    "Content-Type": args.entry.type,
    "Content-Length": source.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(args.corsOrigin),
  })
  args.res.end(source)
}

export function createReviewHandler(deps: HandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { config } = deps
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...config.allowedHosts])

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // A Host check stops DNS rebinding: a page on another domain that resolves
    // to 127.0.0.1 still sends its own name as Host.
    const host = hostName(req.headers.host)
    if (host == null || !allowedHosts.has(host)) {
      sendError({ res, status: 403, error: "forbiddenHost", message: "Host not allowed.", corsOrigin: null })
      return
    }
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : null
    const allowedOrigin = origin != null && config.origins.includes(origin) ? origin : null
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname
    const method = req.method ?? "GET"

    const clientEntry = CLIENT_FILES[path]
    if (clientEntry != null && (method === "GET" || method === "HEAD")) {
      await serveClientFile({ deps, res, entry: clientEntry, corsOrigin: allowedOrigin })
      return
    }

    if (path !== API_PATH) {
      sendError({ res, status: 404, error: "notFound", message: "Not found.", corsOrigin: allowedOrigin })
      return
    }

    // Browsers always send Origin on cross-origin fetches and on POST. A
    // missing Origin on GET is a same-origin or non-browser read, which is
    // allowed; a POST must come from an allowed origin.
    if (origin != null && allowedOrigin == null) {
      sendError({ res, status: 403, error: "forbiddenOrigin", message: "Origin not allowed.", corsOrigin: null })
      return
    }

    switch (method) {
      case "OPTIONS": {
        if (allowedOrigin == null) {
          sendError({ res, status: 403, error: "forbiddenOrigin", message: "Origin not allowed.", corsOrigin: null })
          return
        }
        const headers: Record<string, string> = {
          ...corsHeaders(allowedOrigin),
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "content-type",
          "Access-Control-Max-Age": "600",
        }
        // Chrome sends this preflight header when a public page calls a
        // loopback address; without the matching answer the POST is blocked.
        if (req.headers["access-control-request-private-network"] === "true") {
          headers["Access-Control-Allow-Private-Network"] = "true"
        }
        res.writeHead(204, headers)
        res.end()
        return
      }
      case "GET": {
        const { plan, planError } = await loadPlan(config.planPath)
        sendJson({
          res,
          status: 200,
          body: {
            enabled: true,
            canChooseTarget: config.allowTargetOverride,
            targetAgentId: config.targetAgentId,
            plan,
            planError,
          },
          corsOrigin: allowedOrigin,
        })
        return
      }
      case "POST": {
        if (allowedOrigin == null) {
          sendError({ res, status: 403, error: "forbiddenOrigin", message: "Origin not allowed.", corsOrigin: null })
          return
        }
        await handleReviewPost({ deps, req, res, origin: allowedOrigin })
        return
      }
      default: {
        res.setHeader("Allow", "GET, POST, OPTIONS")
        sendError({ res, status: 405, error: "methodNotAllowed", message: "Method not allowed.", corsOrigin: allowedOrigin })
      }
    }
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendError({
          res,
          status: 500,
          error: "internal",
          message: error instanceof Error ? error.message : String(error),
          corsOrigin: null,
        })
        return
      }
      res.destroy()
    })
  }
}

// Always loopback: the server accepts screenshots of a dev app and starts a
// local CLI, so it is never offered on another interface.
export function startServer(deps: HandlerDeps): Promise<Server> {
  const server = createServer(createReviewHandler(deps))
  server.requestTimeout = 60_000
  server.headersTimeout = 15_000
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(deps.config.port, "127.0.0.1", () => {
      server.off("error", reject)
      resolve(server)
    })
  })
}
