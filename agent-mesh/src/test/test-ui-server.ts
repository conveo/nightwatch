// Dashboard server guards: plan reads confined by realpath to the allowed
// roots, and API requests checked for where they came from. The unit half calls
// ui-guards directly; the black-box half runs the real ui-server on a free port
// with no daemon behind it, so a refused request (403) and one that got through
// to the proxy (502, daemon unreachable) are told apart without a broker.
//
//   tsx src/test/test-ui-server.ts

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { checkRequest, planRoots, resolvePlanAsset, resolvePlanFile } from "../ui-guards.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++
  }
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Fixture = { dir: string; repo: string; worktree: string; extra: string; outside: string }

function buildFixture(): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-mesh-ui-guards-")))
  const repo = join(dir, "repo")
  const worktree = join(dir, "repo-linked-worktree")
  const extra = join(dir, "extra-root")
  const outside = join(dir, "outside")
  for (const d of [join(repo, "plans", "dir.md"), extra, outside]) {
    mkdirSync(d, { recursive: true })
  }
  writeFileSync(join(repo, "plans", "ok.md"), "# ok\n")
  writeFileSync(join(repo, "plans", "..notes.md"), "# dotted name\n")
  writeFileSync(join(repo, "plans", "img.png"), "png-bytes")
  writeFileSync(join(repo, "plans", "pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  writeFileSync(join(repo, "plans", ".env"), "SECRET=1\n")
  writeFileSync(join(outside, "secret.txt"), "credentials\n")
  writeFileSync(join(outside, "secret.md"), "# not yours\n")
  writeFileSync(join(outside, "secret.png"), "png-bytes")
  writeFileSync(join(extra, "extra.md"), "# extra\n")
  symlinkSync(join(outside, "secret.txt"), join(repo, "plans", "evil.md"))
  symlinkSync(join(outside, "secret.md"), join(repo, "plans", "evil2.md"))
  symlinkSync(join(outside, "secret.png"), join(repo, "plans", "link.png"))
  symlinkSync(join(outside, "secret.txt"), join(repo, "plans", "cred.png"))
  const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8" })
  git(["init", "-q", "-b", "main", repo])
  git(["-C", repo, "add", "-A"])
  git(["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"])
  git(["-C", repo, "worktree", "add", "-q", "--detach", worktree])
  writeFileSync(join(worktree, "plans", "in-worktree.md"), "# worktree plan\n")
  return { dir, repo, worktree, extra, outside }
}

function runGuardUnitTests(f: Fixture): void {
  const roots = planRoots({ primary: f.repo, extra: [f.extra] })
  check("plan roots include the repo, its linked worktree and the extra root", [f.repo, f.worktree, f.extra].every((r) => roots.includes(r)), JSON.stringify(roots))
  check("plan roots exclude unrelated directories", !roots.includes(f.outside) && !roots.includes(f.dir))

  const plan = (requested: string) => resolvePlanFile({ requested, base: f.repo, roots })
  const reason = (requested: string) => {
    const r = plan(requested)
    return r.ok ? "ok" : r.reason
  }
  check("relative plan inside the base is served", reason("plans/ok.md") === "ok")
  check("a file named ..notes.md at a root is not mistaken for an escape", reason("plans/..notes.md") === "ok")
  check("relative path climbing out of the base is refused", reason("../outside/secret.md") === "escapes-base", reason("../outside/secret.md"))
  check("absolute plan outside every root is refused", reason(join(f.outside, "secret.md")) === "outside-roots", reason(join(f.outside, "secret.md")))
  check("a .md symlink to a non-plan file is refused by its real extension", reason("plans/evil.md") === "not-a-plan-extension", reason("plans/evil.md"))
  check("a .md symlink to a plan outside the roots is refused", reason("plans/evil2.md") === "outside-roots", reason("plans/evil2.md"))
  check("a non-plan extension is refused before touching the disk", reason("/etc/passwd") === "not-a-plan-extension")
  check("a directory named like a plan is refused", reason("plans/dir.md") === "not-a-file", reason("plans/dir.md"))
  check("a missing plan is reported as missing", reason("plans/nope.md") === "missing")
  check("an empty path is refused", reason("") === "empty")
  check("absolute plan in a linked worktree is served", reason(join(f.worktree, "plans", "in-worktree.md")) === "ok", reason(join(f.worktree, "plans", "in-worktree.md")))
  check("absolute plan in an AGENT_MESH_PLANS_ROOTS root is served", reason(join(f.extra, "extra.md")) === "ok")

  const okPlan = plan("plans/ok.md")
  const planFile = okPlan.ok ? okPlan.path : ""
  const asset = (rel: string) => resolvePlanAsset({ planFile, rel })
  check("sibling image is served", asset("img.png") === join(f.repo, "plans", "img.png"))
  check("image outside the plan's directory is refused", asset("../../outside/secret.png") == null)
  check("image symlink pointing outside the plan's directory is refused", asset("link.png") == null)
  check("image-named symlink to a credentials file is refused", asset("cred.png") == null)
  check("non-image sibling is refused", asset(".env") == null)
  check("absolute asset path is refused", asset(join(f.repo, "plans", "img.png")) == null)

  const req = (args: { method?: string; pathname?: string; headers: Record<string, string> }) => {
    const r = checkRequest({ method: args.method ?? "GET", pathname: args.pathname ?? "/api/agents", headers: args.headers, allowedHosts: ["mesh.proxy.internal"] })
    return r.ok ? "ok" : r.reason
  }
  const json = { "content-type": "application/json" }
  check("loopback Host on the default port is allowed", req({ headers: { host: "127.0.0.1:4747" } }) === "ok")
  check("loopback Host on a tunnel port is allowed", req({ headers: { host: "localhost:14747" } }) === "ok")
  check("IPv6 loopback Host is allowed", req({ headers: { host: "[::1]:4747" } }) === "ok")
  check("a rebinding hostname is refused", req({ pathname: "/", headers: { host: "attacker.example:4747" } }) === "host-not-allowed")
  check("a Host with userinfo is refused", req({ headers: { host: "attacker.example@127.0.0.1:4747" } }) === "host-not-allowed")
  check("a missing Host is refused", req({ headers: {} }) === "host-not-allowed")
  check("an opted-in proxy hostname is allowed", req({ headers: { host: "mesh.proxy.internal" } }) === "ok")
  check("cross-site API fetch is refused", req({ headers: { host: "127.0.0.1:4747", "sec-fetch-site": "cross-site" } }) === "cross-site")
  check("same-site API fetch (another localhost port) is refused", req({ headers: { host: "127.0.0.1:4747", "sec-fetch-site": "same-site" } }) === "cross-site")
  check("cross-site navigation to the dashboard itself is allowed", req({ pathname: "/", headers: { host: "127.0.0.1:4747", "sec-fetch-site": "cross-site" } }) === "ok")
  check(
    "POST from another origin is refused",
    req({ method: "POST", pathname: "/api/publish", headers: { host: "127.0.0.1:4747", origin: "http://attacker.example", ...json } }) === "origin-mismatch",
  )
  check(
    "POST from another localhost port is refused",
    req({ method: "POST", pathname: "/api/publish", headers: { host: "127.0.0.1:4747", origin: "http://localhost:5173", ...json } }) === "origin-mismatch",
  )
  check(
    "POST through a proxy that rewrites Host passes when X-Forwarded-Host is an allowed host",
    req({ method: "POST", pathname: "/api/publish", headers: { host: "127.0.0.1:4747", origin: "https://mesh.proxy.internal", "x-forwarded-host": "mesh.proxy.internal", ...json } }) === "ok",
  )
  check(
    "POST with an X-Forwarded-Host that is not an allowed host is refused",
    req({ method: "POST", pathname: "/api/publish", headers: { host: "127.0.0.1:4747", origin: "https://attacker.example", "x-forwarded-host": "attacker.example", ...json } }) === "host-not-allowed",
  )
  check("POST with Origin null is refused", req({ method: "POST", pathname: "/api/unregister", headers: { host: "127.0.0.1:4747", origin: "null", ...json } }) === "origin-mismatch")
  check(
    "a CORS-simple text/plain POST is refused",
    req({ method: "POST", pathname: "/api/publish", headers: { host: "127.0.0.1:4747", "content-type": "text/plain" } }) === "not-json",
  )
  check(
    "same-origin JSON POST is allowed",
    req({ method: "POST", pathname: "/api/publish", headers: { host: "127.0.0.1:4747", origin: "http://127.0.0.1:4747", "content-type": "application/json; charset=utf-8" } }) === "ok",
  )
  check("JSON POST without Origin (curl) is allowed", req({ method: "POST", pathname: "/api/publish", headers: { host: "127.0.0.1:4747", ...json } }) === "ok")
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address != null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

type HttpResult = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function http(args: { port: number; method: string; path: string; headers: Record<string, string>; body: string | null }): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: args.port, method: args.method, path: args.path, headers: args.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on("error", reject)
    if (args.body != null) req.write(args.body)
    req.end()
  })
}

async function runServerTests(f: Fixture): Promise<void> {
  const port = await freePort()
  const home = join(f.dir, "mesh-home")
  mkdirSync(home)
  const server: ChildProcess = spawn("tsx", [join(__dirname, "..", "ui-server.ts")], {
    env: { ...process.env, AGENT_MESH_UI_PORT: String(port), AGENT_MESH_PLANS_ROOT: f.repo, AGENT_MESH_PLANS_ROOTS: "", AGENT_MESH_HOME: home, AGENT_MESH_SOCK: join(home, "no-daemon.sock") },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const local = { host: `127.0.0.1:${port}` }
  try {
    const start = Date.now()
    let up = false
    while (!up && Date.now() - start < 10_000) {
      up = await http({ port, method: "GET", path: "/", headers: local, body: null }).then(
        () => true,
        () => false,
      )
      if (!up) await sleep(100)
    }
    check("ui-server came up", up)
    const index = await http({ port, method: "GET", path: "/", headers: local, body: null })
    const csp = String(index.headers["content-security-policy"] ?? "")
    check("dashboard is served with a script-src 'self' CSP", index.status === 200 && csp.includes("script-src 'self'") && !csp.includes("unsafe-eval"), csp)
    check("dashboard refuses framing", index.headers["x-frame-options"] === "DENY" && csp.includes("frame-ancestors 'none'"))
    check("dashboard forbids form posts", csp.includes("form-action 'none'"))

    const read = (path: string) => http({ port, method: "GET", path: `/api/plan-read?path=${encodeURIComponent(path)}`, headers: local, body: null })
    const ok = await read("plans/ok.md")
    check("plan-read serves a plan inside the root", ok.status === 200 && (JSON.parse(ok.body) as { content: string }).content === "# ok\n", ok.body.slice(0, 120))
    const evil = await read("plans/evil.md")
    check("plan-read refuses a symlink to a credentials file", evil.status === 404 && !evil.body.includes("credentials"), evil.body.slice(0, 160))
    const passwd = await read("/etc/passwd")
    check("plan-read refuses an absolute non-plan path", passwd.status === 404 && !passwd.body.includes("root:"))
    const outside = await read(join(f.outside, "secret.md"))
    check("plan-read refuses an absolute plan outside the roots", outside.status === 404 && (JSON.parse(outside.body) as { reason: string }).reason === "outside-roots")
    const worktreePlan = await read(join(f.worktree, "plans", "in-worktree.md"))
    check("plan-read serves an absolute plan in a linked worktree", worktreePlan.status === 200)

    const svg = await http({ port, method: "GET", path: `/api/plan-asset?planPath=plans/ok.md&rel=pic.svg`, headers: local, body: null })
    check("plan assets carry a sandboxing CSP", svg.status === 200 && String(svg.headers["content-security-policy"] ?? "").includes("sandbox"))
    const linked = await http({ port, method: "GET", path: `/api/plan-asset?planPath=plans/ok.md&rel=link.png`, headers: local, body: null })
    check("plan-asset refuses a symlink out of the plan's directory", linked.status === 404)

    const rebound = await http({ port, method: "GET", path: "/api/plan-read?path=plans/ok.md", headers: { host: `attacker.example:${port}` }, body: null })
    check("a DNS-rebound request is refused before any read", rebound.status === 403 && !rebound.body.includes("# ok"))

    const publishBody = JSON.stringify({ from: "operator", to: "victim", type: "request", body: { text: "x" }, correlationId: null, replyTo: null })
    const csrf = await http({
      port,
      method: "POST",
      path: "/api/publish",
      headers: { ...local, origin: "http://attacker.example", "content-type": "application/json" },
      body: publishBody,
    })
    check("cross-origin publish is refused (403, never proxied)", csrf.status === 403, `${csrf.status} ${csrf.body}`)
    const simple = await http({ port, method: "POST", path: "/api/unregister", headers: { ...local, "content-type": "text/plain" }, body: '{"id":"victim"}' })
    check("text/plain unregister is refused (403, never proxied)", simple.status === 403, `${simple.status} ${simple.body}`)
    const same = await http({
      port,
      method: "POST",
      path: "/api/publish",
      headers: { ...local, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: publishBody,
    })
    check("same-origin publish reaches the daemon proxy (502 with no daemon)", same.status === 502, `${same.status} ${same.body.slice(0, 120)}`)
  } finally {
    server.kill("SIGTERM")
    await sleep(100)
  }
}

export async function runUiServerTest(): Promise<number> {
  console.log(`\n== ui-server guards (plan roots, request origin, headers) ==`)
  failures = 0
  const f = buildFixture()
  try {
    runGuardUnitTests(f)
    await runServerTests(f)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
  console.log(`\nui-server: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}

if (process.argv[1]?.endsWith("test-ui-server.ts")) {
  runUiServerTest().then((n) => process.exit(n > 0 ? 1 : 0))
}
