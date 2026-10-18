// agent-mesh UI — a local dashboard over the daemon's unix-socket API.
//
// Browsers can't speak unix sockets, so this tiny server does two things:
//   1. serves the built React dashboard (dashboard/dist — Vite + ShadCN)
//   2. bridges /api/* fetches to the daemon socket (roster, publish, unregister)
//
// The dashboard is a separate package (agent-mesh/dashboard) so a daemon
// bootstrap never pulls React/Vite. The `ui` script builds it on demand; in
// development run `pnpm --dir agent-mesh/dashboard dev` (vite proxies /api here).
//
// Message inspection reads the host-local inbox files directly (NOT the daemon's
// GET /inbox): the files hold the full delivered history, and reading them never
// advances an agent's read cursor — inspecting must stay side-effect free.
//
// Run:  pnpm --dir agent-mesh ui     (requires a running daemon on this host)

import { createServer, type ServerResponse } from "node:http"
import { json } from "./http-json.js"
import { existsSync, readFileSync } from "node:fs"
import { basename, delimiter, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  consoleConfig,
  handleChat,
  handleConsoleEvents,
  handleConversations,
  handleMeshTool,
  handleNarrate,
  handleClientEvent,
  handleArrivalOwner,
  handleConversationList,
  handleDiagnostics,
  handleDigest,
  handleReceipts,
  handlePresence,
  handleTranscriptRead,
  handleTranscriptWrite,
  handlePushConfig,
  handlePushSubscribe,
  handleRealtimeSession,
  handleThread,
  startInboxDelivery,
} from "./console-routes.js"
import { getAgentState, getLocalAgents, socketPath } from "./local-store.js"
import { inspect, proxyToDaemon, readInboxHistory } from "./mesh-read.js"
import { agentIdSchema } from "./types.js"
import { checkRequest, gitToplevel, planRoots, resolvePlanAsset, resolvePlanFile, securityHeaders } from "./ui-guards.js"

const portEnv = process.env.AGENT_MESH_UI_PORT
const PORT = portEnv != null ? Number(portEnv) : 4747
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  process.stderr.write(`[agent-mesh] invalid AGENT_MESH_UI_PORT: ${portEnv}\n`)
  process.exit(1)
}
const PACKAGE_DIR = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."))
const DIST_DIR = join(PACKAGE_DIR, "dashboard", "dist")
// Base for RELATIVE plan paths: the git checkout this ui-server runs from (the
// package's parent when it is not in git), or AGENT_MESH_PLANS_ROOT. The
// dashboard usually runs from a checkout other than the one a plan lives in, so
// absolute paths into any worktree of that repository are readable too, plus
// the directories listed in AGENT_MESH_PLANS_ROOTS (path-delimiter separated).
// Nothing outside those roots is served, whatever its extension.
const PLANS_ROOT =
  process.env.AGENT_MESH_PLANS_ROOT != null && process.env.AGENT_MESH_PLANS_ROOT !== ""
    ? resolve(process.env.AGENT_MESH_PLANS_ROOT)
    : (gitToplevel(PACKAGE_DIR) ?? normalize(join(PACKAGE_DIR, "..")))
const EXTRA_PLAN_ROOTS = (process.env.AGENT_MESH_PLANS_ROOTS ?? "").split(delimiter).filter((p) => p !== "")
// Hostnames besides the loopback names that may appear in the Host header, for
// a reverse proxy that forwards its own name. Comma separated.
const ALLOWED_HOSTS = (process.env.AGENT_MESH_UI_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter((h) => h !== "")
// Tailscale logins allowed through a proxy (tailscale serve), comma separated.
const ALLOWED_USERS = (process.env.AGENT_MESH_UI_ALLOWED_USERS ?? "")
  .split(",")
  .map((u) => u.trim().toLowerCase())
  .filter((u) => u !== "")

function currentPlanRoots(): string[] {
  return planRoots({ primary: PLANS_ROOT, extra: EXTRA_PLAN_ROOTS })
}

type PlanDoc = { path: string; name: string; content: string; format: "markdown" | "html"; root: string }

// Read a plan doc (markdown or HTML). `path` is echoed back so the client builds
// asset URLs against the same plan; `root` tells the UI where relative paths
// resolve from.
function readPlan(p: string): { ok: true; plan: PlanDoc } | { ok: false; reason: string; roots: string[] } {
  const roots = currentPlanRoots()
  const resolved = resolvePlanFile({ requested: p, base: PLANS_ROOT, roots })
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, roots }
  }
  const abs = resolved.path
  return {
    ok: true,
    plan: { path: p, name: basename(p), content: readFileSync(abs, "utf8"), format: /\.html?$/i.test(abs) ? "html" : "markdown", root: PLANS_ROOT },
  }
}

// Serve a sibling asset of a plan (e.g. an <img> an HTML plan references by
// relative path), constrained to the plan's own directory. Binary, so it's
// handled in the top-level server rather than the JSON `handle()`.
function servePlanAsset(res: ServerResponse, planPath: string, rel: string): void {
  const plan = resolvePlanFile({ requested: planPath, base: PLANS_ROOT, roots: currentPlanRoots() })
  const assetAbs = plan.ok ? resolvePlanAsset({ planFile: plan.path, rel }) : null
  if (assetAbs == null) {
    res.writeHead(404, securityHeaders("asset"))
    res.end()
    return
  }
  const ext = extname(assetAbs).toLowerCase()
  res.writeHead(200, { ...securityHeaders("asset"), "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" })
  res.end(readFileSync(assetAbs))
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".webmanifest": "application/manifest+json; charset=utf-8",
}

// Serve a static asset from the built dashboard, path-traversal safe. Returns
// null when the file isn't in dist (caller decides the fallback).
function serveDistFile(pathname: string): { contentType: string; bytes: Buffer } | null {
  const cleaned = pathname === "/" ? "/index.html" : pathname
  const target = normalize(join(DIST_DIR, cleaned))
  const rel = relative(DIST_DIR, target)
  if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(target)) {
    return null
  }
  return { contentType: CONTENT_TYPES[extname(target)] ?? "application/octet-stream", bytes: readFileSync(target) }
}

const MISSING_BUILD_HTML = `<!doctype html><meta charset="utf-8"><body style="font:14px ui-monospace,monospace;background:#1a1916;color:#e8e2d6;padding:2rem">
<h2 style="color:#e0a83f">agent-mesh dashboard not built</h2>
<p>The dashboard is a separate package. Build it once:</p>
<pre style="background:#000;padding:1rem;border-radius:8px">pnpm --dir agent-mesh/dashboard install
pnpm --dir agent-mesh/dashboard build</pre>
<p>then reload. (The <code>pnpm --dir agent-mesh ui</code> script does this for you.)</p></body>`

// The largest request body accepted. A transcript save carries a conversation
// window (up to 400 messages), which stays well under this.
const MAX_BODY_BYTES = 10 * 1024 * 1024

class BodyTooLargeError extends Error {}

function readRequestBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError(`request body over ${MAX_BODY_BYTES} bytes`))
        ;(req as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString()))
    req.on("error", reject)
  })
}

const server = createServer((req, res) => {
  const method = req.method ?? "GET"
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname

  const allowed = checkRequest({ method, pathname, headers: req.headers, allowedHosts: ALLOWED_HOSTS, allowedUsers: ALLOWED_USERS })
  if (!allowed.ok) {
    res.writeHead(403, { ...securityHeaders("api"), "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "request refused", reason: allowed.reason }))
    return
  }

  // Static dashboard assets (everything that isn't /api/*). The SPA has a single
  // route, so a missing path falls back to index.html (or the build hint).
  if (method === "GET" && !pathname.startsWith("/api/")) {
    const file = serveDistFile(pathname)
    if (file != null) {
      res.writeHead(200, { ...securityHeaders("dashboard"), "Content-Type": file.contentType })
      res.end(file.bytes)
      return
    }
    const index = serveDistFile("/index.html")
    if (index != null) {
      res.writeHead(200, { ...securityHeaders("dashboard"), "Content-Type": index.contentType })
      res.end(index.bytes)
      return
    }
    res.writeHead(200, { ...securityHeaders("dashboard"), "Content-Type": "text/html; charset=utf-8" })
    res.end(MISSING_BUILD_HTML)
    return
  }

  // The inbound mesh feed is a long-lived SSE stream; it owns `res` for the life of
  // the tab and must never go through the buffered JSON `handle()`.
  if (method === "GET" && pathname === "/api/console/events") {
    handleConsoleEvents(res)
    return
  }

  // The assistant's reply is a live SSE stream, so it writes to `res` itself
  // rather than going through the buffered JSON `handle()`.
  if (method === "POST" && (pathname === "/api/console/chat" || pathname === "/api/console/narrate")) {
    const run = pathname === "/api/console/chat" ? handleChat : handleNarrate
    readRequestBody(req)
      .then((body) => run({ res, rawBody: body }))
      .catch((e: Error) => {
        if (!res.headersSent) {
          json(res, e instanceof BodyTooLargeError ? 413 : 502, { error: e.message })
          return
        }
        res.end()
      })
    return
  }

  // Plan sibling assets are binary, so they bypass the JSON `handle()`.
  if (method === "GET" && pathname === "/api/plan-asset") {
    const q = new URL(req.url ?? "/", "http://localhost").searchParams
    servePlanAsset(res, q.get("planPath") ?? "", q.get("rel") ?? "")
    return
  }

  handle(method, req).then(
    (out) => {
      res.writeHead(out.status, { ...securityHeaders("api"), "Content-Type": "application/json" })
      res.end(out.body)
    },
    (e: Error) =>
      e instanceof BodyTooLargeError
        ? json(res, 413, { error: e.message })
        : json(res, 502, { error: `daemon unreachable at ${socketPath()}: ${e.message}` }),
  )
})

async function handle(method: string, req: NodeJS.ReadableStream & { url?: string }): Promise<{ status: number; body: string }> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const route = `${method} ${url.pathname}`

  if (route === "GET /api/health") {
    return proxyToDaemon({ method: "GET", path: "/health", body: null })
  }
  if (route === "GET /api/agents") {
    return proxyToDaemon({ method: "GET", path: "/agents", body: null })
  }
  if (route === "GET /api/activity") {
    return proxyToDaemon({ method: "GET", path: "/activity", body: null })
  }
  if (route === "POST /api/publish") {
    return proxyToDaemon({ method: "POST", path: "/publish", body: await readRequestBody(req) })
  }
  if (route === "POST /api/unregister") {
    return proxyToDaemon({ method: "POST", path: "/unregister", body: await readRequestBody(req) })
  }
  if (route === "GET /api/local") {
    // Which agents THIS daemon serves, with unread counts derived from the
    // inbox buffer vs the agent's read cursor.
    const local = Object.values(getLocalAgents())
      .filter((def) => agentIdSchema.safeParse(def.id).success)
      .map((def) => {
        const total = readInboxHistory(def.id).length
        const state = getAgentState(def.id)
        return { id: def.id, total, unread: Math.max(0, total - state.readCount) }
      })
    return { status: 200, body: JSON.stringify(local) }
  }
  if (route === "GET /api/inspect") {
    const parsed = agentIdSchema.safeParse(url.searchParams.get("id") ?? "")
    if (!parsed.success) {
      return { status: 400, body: JSON.stringify({ error: "invalid agent id" }) }
    }
    return { status: 200, body: JSON.stringify(await inspect(parsed.data)) }
  }
  // ── mobile console (additive; the desktop dashboard uses none of these) ────
  if (route === "GET /api/console/config") {
    return { status: 200, body: JSON.stringify(await consoleConfig()) }
  }
  if (route === "GET /api/console/conversations") {
    return handleConversations(url)
  }
  if (route === "GET /api/console/thread") {
    return handleThread(url)
  }
  if (route === "POST /api/console/mesh-tool") {
    return handleMeshTool(await readRequestBody(req))
  }
  if (route === "GET /api/console/diagnostics") {
    return handleDiagnostics()
  }
  if (route === "GET /api/console/conversations-list") {
    return handleConversationList()
  }
  if (route === "GET /api/console/digest") {
    return handleDigest(url)
  }
  if (route === "GET /api/console/receipts") {
    return handleReceipts(url)
  }
  if (route === "GET /api/console/arrival-owner") {
    return handleArrivalOwner(url)
  }
  if (route === "GET /api/console/transcript") {
    return handleTranscriptRead(url)
  }
  if (route === "PUT /api/console/transcript") {
    return handleTranscriptWrite(await readRequestBody(req), url)
  }
  if (route === "POST /api/console/client-event") {
    return handleClientEvent(await readRequestBody(req))
  }
  if (route === "POST /api/console/presence") {
    return handlePresence()
  }
  if (route === "GET /api/console/push") {
    return handlePushConfig(url.searchParams.get("endpoint"))
  }
  if (route === "POST /api/console/push") {
    return handlePushSubscribe(await readRequestBody(req))
  }
  if (route === "POST /api/console/realtime-session") {
    return handleRealtimeSession(await readRequestBody(req))
  }
  if (route === "GET /api/plan-read") {
    const tried = url.searchParams.get("path") ?? ""
    const read = readPlan(tried)
    if (!read.ok) {
      return { status: 404, body: JSON.stringify({ error: "plan not found", reason: read.reason, tried, root: PLANS_ROOT, roots: read.roots }) }
    }
    return { status: 200, body: JSON.stringify(read.plan) }
  }
  return { status: 404, body: JSON.stringify({ error: `no route ${route}` }) }
}

// Loopback only. The API has no authentication, so a wider bind would hand
// publish, unregister and every agent's message history to the network. Reach a
// remote host's dashboard through an SSH tunnel; checkRequest accepts any
// loopback port, so a tunnel on a different local port works.
server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`[agent-mesh] ui on http://127.0.0.1:${PORT} (daemon socket: ${socketPath()})\n`)
  // Only once the port is ours — see startInboxDelivery.
  startInboxDelivery()
})
