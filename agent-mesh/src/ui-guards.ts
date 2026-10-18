// Request and file-path guards for the dashboard server (ui-server.ts), kept
// apart from the server so they can be tested without binding a port.
//
// The server is reachable by more than the operator's own tab: any page the
// operator has open can send requests to 127.0.0.1, a DNS-rebinding page can
// read the responses, and the plan files it renders are written by agents (or
// arrive on branches other agents pushed). So every plan read is confined by
// realpath to the allowed roots, and every API request is checked for where it
// came from before it reaches the daemon or the disk.

import { execFileSync } from "node:child_process"
import { realpathSync, statSync } from "node:fs"
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"

export const PLAN_EXTS = new Set([".md", ".markdown", ".html", ".htm"])
// Images only, so /api/plan-asset cannot be used to read the .env/.json files
// that happen to sit beside a plan.
export const ASSET_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"])

// True when `target` is strictly inside `root`. Both must already be resolved
// (and realpath'd when symlinks matter). A bare `startsWith("..")` test would
// also reject a legitimate file named `..notes.md` at the root.
export function isWithin({ root, target }: { root: string; target: string }): boolean {
  const rel = relative(root, target)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

// The git working tree that contains `dir`, or null outside git.
export function gitToplevel(dir: string): string | null {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim()
    return out === "" ? null : out
  } catch {
    return null
  }
}

// Every worktree of the repository that contains `dir` (the main checkout and
// each linked one). Plans are usually written in an agent's own worktree while
// the dashboard runs from the base checkout, so all of them count as roots.
function gitWorktrees(dir: string): string[] {
  try {
    const out = execFileSync("git", ["-C", dir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    })
    return out
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
  } catch {
    return []
  }
}

// The directories a plan may be read from, realpath'd and de-duplicated:
// `primary`, every git worktree of the repository containing it, and `extra`
// (AGENT_MESH_PLANS_ROOTS). Computed per call because worktrees come and go
// while the server runs; `git worktree list` is a few milliseconds.
export function planRoots({ primary, extra }: { primary: string; extra: string[] }): string[] {
  const roots = new Set<string>()
  for (const candidate of [primary, ...gitWorktrees(primary), ...extra]) {
    if (candidate === "") continue
    const real = realpathOrNull(resolve(candidate))
    if (real != null) roots.add(real)
  }
  return [...roots]
}

export type PlanFileResult =
  | { ok: true; path: string }
  | { ok: false; reason: "empty" | "not-a-plan-extension" | "escapes-base" | "missing" | "not-a-file" | "outside-roots" }

// Resolve a requested plan path to the real file it names. Relative paths
// resolve against `base` and may not climb out of it; absolute paths are taken
// as given. Either way the REAL path (symlinks followed) must be a plan file
// inside one of `roots`: checking only the requested name would let
// `plans/x.md -> ~/.aws/credentials`, which git happily checks out from
// someone else's branch, serve the credentials file.
export function resolvePlanFile({ requested, base, roots }: { requested: string; base: string; roots: string[] }): PlanFileResult {
  if (requested === "") {
    return { ok: false, reason: "empty" }
  }
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(base, requested)
  if (!isAbsolute(requested) && !isWithin({ root: resolve(base), target: candidate })) {
    return { ok: false, reason: "escapes-base" }
  }
  if (!PLAN_EXTS.has(extname(candidate).toLowerCase())) {
    return { ok: false, reason: "not-a-plan-extension" }
  }
  const real = realpathOrNull(candidate)
  if (real == null) {
    return { ok: false, reason: "missing" }
  }
  if (!PLAN_EXTS.has(extname(real).toLowerCase())) {
    return { ok: false, reason: "not-a-plan-extension" }
  }
  if (!statSync(real).isFile()) {
    return { ok: false, reason: "not-a-file" }
  }
  if (!roots.some((root) => isWithin({ root, target: real }))) {
    return { ok: false, reason: "outside-roots" }
  }
  return { ok: true, path: real }
}

// Resolve an image a plan references by relative path. `planFile` is the real
// path resolvePlanFile returned; the asset's real path must be an image inside
// that plan's own directory.
export function resolvePlanAsset({ planFile, rel }: { planFile: string; rel: string }): string | null {
  if (rel === "" || isAbsolute(rel)) {
    return null
  }
  const dir = dirname(planFile)
  const candidate = resolve(dir, rel)
  if (!isWithin({ root: dir, target: candidate }) || !ASSET_EXTS.has(extname(candidate).toLowerCase())) {
    return null
  }
  const real = realpathOrNull(candidate)
  if (real == null || !ASSET_EXTS.has(extname(real).toLowerCase()) || !statSync(real).isFile()) {
    return null
  }
  return isWithin({ root: dir, target: real }) ? real : null
}

// ---- request origin ----

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"])

function hostnameOf(hostHeader: string): string | null {
  try {
    const url = new URL(`http://${hostHeader}`)
    // A Host header carrying a path, credentials, query or fragment is not a
    // host: `evil.example@127.0.0.1` would otherwise parse as loopback.
    return /[/?#@\\]/.test(hostHeader) ? null : url.hostname
  } catch {
    return null
  }
}

export type RequestCheck = { ok: true } | { ok: false; reason: "host-not-allowed" | "user-not-allowed" | "cross-site" | "origin-mismatch" | "not-json" }

type RequestCheckArgument = {
  method: string
  pathname: string
  headers: Record<string, string | string[] | undefined>
  // Extra hostnames (AGENT_MESH_UI_ALLOWED_HOSTS) for a reverse proxy that
  // forwards its own name; loopback names are always allowed.
  allowedHosts: string[]
  // Tailscale logins (AGENT_MESH_UI_ALLOWED_USERS). When set, a request that came
  // through a proxy must carry one of them in Tailscale-User-Login.
  allowedUsers?: string[]
}

function header(headers: RequestCheckArgument["headers"], name: string): string | null {
  const value = headers[name]
  if (value == null) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

// The host:port values a same-origin page can have. A reverse proxy that
// rewrites Host to the loopback target (tailscale serve does) passes the page's
// own host in X-Forwarded-Host; that name counts only when it is listed in
// allowedHosts. A cross-site page cannot set the header without a CORS
// preflight, which this server never answers.
function originHosts({ host, headers, allowedHosts }: { host: string; headers: RequestCheckArgument["headers"]; allowedHosts: string[] }): string[] {
  const hosts = [host.toLowerCase()]
  const forwarded = header(headers, "x-forwarded-host")
  const forwardedName = forwarded == null ? null : hostnameOf(forwarded)
  if (forwarded != null && forwardedName != null && allowedHosts.includes(forwardedName)) {
    hosts.push(forwarded.toLowerCase())
  }
  return hosts
}

// Decide whether a request may be served.
//  - Host must be a loopback name (any port, so an SSH tunnel to another local
//    port works). This is what stops DNS rebinding: a rebound page sends its
//    own hostname, and without this check it could read every API response.
//  - /api/* refuses requests a browser marks as cross-site or same-site (any
//    other origin, including another localhost port). The dashboard document
//    itself stays reachable from links, so deep links keep working.
//  - A state-changing request whose Origin is present must come from this same
//    host:port, and must be JSON. JSON forces a CORS preflight, which this
//    server never answers, so even a browser without Sec-Fetch-Site or Origin
//    cannot send one cross-origin. Clients without Origin (curl, scripts) are
//    not browsers and pass.
export function checkRequest({ method, pathname, headers, allowedHosts, allowedUsers = [] }: RequestCheckArgument): RequestCheck {
  const host = header(headers, "host")
  const hostname = host == null ? null : hostnameOf(host)
  if (host == null || hostname == null || !(LOOPBACK_HOSTNAMES.has(hostname) || allowedHosts.includes(hostname))) {
    return { ok: false, reason: "host-not-allowed" }
  }
  // A proxy that rewrites Host to loopback passes the name the browser used in
  // X-Forwarded-Host. That name must be allowed too, or DNS rebinding through the
  // proxy gets past the Host check above.
  const forwarded = header(headers, "x-forwarded-host")
  const forwardedName = forwarded == null ? null : hostnameOf(forwarded)
  if (forwarded != null && (forwardedName == null || !(LOOPBACK_HOSTNAMES.has(forwardedName) || allowedHosts.includes(forwardedName)))) {
    return { ok: false, reason: "host-not-allowed" }
  }
  // tailscale serve adds the requester's login (and strips one a client sends);
  // tailscale funnel, which is public, adds none. So with a user list set, a
  // proxied request without a listed login is refused.
  const viaProxy = forwarded != null || !LOOPBACK_HOSTNAMES.has(hostname)
  if (viaProxy && allowedUsers.length > 0) {
    const login = header(headers, "tailscale-user-login")?.toLowerCase() ?? null
    if (login == null || !allowedUsers.includes(login)) {
      return { ok: false, reason: "user-not-allowed" }
    }
  }
  if (!pathname.startsWith("/api/")) {
    return { ok: true }
  }
  const fetchSite = header(headers, "sec-fetch-site")
  if (fetchSite === "cross-site" || fetchSite === "same-site") {
    return { ok: false, reason: "cross-site" }
  }
  if (method === "GET" || method === "HEAD") {
    return { ok: true }
  }
  const origin = header(headers, "origin")?.toLowerCase() ?? null
  if (origin != null && !originHosts({ host, headers, allowedHosts }).some((h) => origin === `http://${h}` || origin === `https://${h}`)) {
    return { ok: false, reason: "origin-mismatch" }
  }
  const contentType = (header(headers, "content-type") ?? "").split(";")[0].trim().toLowerCase()
  if (contentType !== "application/json") {
    return { ok: false, reason: "not-json" }
  }
  return { ok: true }
}

// ---- response headers ----

const COMMON_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
}

// The dashboard renders agent-written plans into its own DOM after sanitizing
// them; this policy is the second layer. `script-src 'self'` blocks inline
// scripts and event handlers a sanitizer gap would let through, which is why
// the theme bootstrap lives in public/theme-init.js instead of inline. Inline
// styles stay allowed because HTML plans carry their own <style> blocks.
// form-action 'none' because the dashboard has no forms and a form in a plan
// must not be able to post anywhere. connect-src allows OpenAI's realtime
// endpoint because the console's voice mode opens its WebSocket from the
// browser, with a short-lived token the server issues.
const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' wss://api.openai.com https://api.openai.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ")

// A plan asset is fetched by URL, so a plan can link to one and get it opened
// as a document. `sandbox` gives that document an opaque origin, so an SVG
// with script cannot act as the dashboard even if it runs.
const ASSET_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'"

const API_CSP = "default-src 'none'; frame-ancestors 'none'"

export function securityHeaders(kind: "dashboard" | "asset" | "api"): Record<string, string> {
  switch (kind) {
    case "dashboard":
      return { ...COMMON_HEADERS, "Content-Security-Policy": DASHBOARD_CSP }
    case "asset":
      return { ...COMMON_HEADERS, "Content-Security-Policy": ASSET_CSP }
    case "api":
      // Messages, transcripts and plans do not belong in any cache.
      return { ...COMMON_HEADERS, "Content-Security-Policy": API_CSP, "Cache-Control": "no-store" }
  }
}
