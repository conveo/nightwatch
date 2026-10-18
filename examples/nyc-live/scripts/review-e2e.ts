// Prove that a person can review the app with the reviewer overlay, end to end.
//
//   node scripts/review-e2e.ts --env-file <file with OPENAI_API_KEY>
//   node scripts/review-e2e.ts --via-proxy      # open the app through a proxy on another host name
//   node scripts/review-e2e.ts --record         # also save check:visual's answers (test/recordings/)
//
// It runs the two commands of the README's "Review it" section with everything they
// need, all of it throwaway and stopped again at the end, even on failure: a Redis
// container and an agent-mesh daemon with their own AGENT_MESH_HOME (never the mesh
// you work on), a reviewer agent, `pnpm overlay`, `pnpm dev` with NYC_LIVE_OVERLAY,
// and a headless Chrome that accepts tab capture. It opens the venue with
// sel=bin:1007945, opens the Reviewer panel, drops a pin on the venue, sends a note,
// reads the reviewer's inbox and checks the note: the comment, a page URL whose hash
// is the view that was open, and a screenshot that passes checks/review-note.json.
// Exits 0 only when all of that holds. Needs Docker, pnpm and Chrome (CHROME).

import { execFile, spawn, type ChildProcess } from "node:child_process"
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs"
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http"
import { connect, createServer as createNetServer, type AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import process, { env } from "node:process"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual, parseArgs, promisify } from "node:util"
import { DEFAULT_VIEW, parseViewState, serializeViewState, type ViewState } from "../src/view-state.ts"
import { devtoolsAnswering, findChrome } from "./chrome.ts"

// Neutral ids: the committed screenshot and the note can show them.
export const REVIEWER_ID = "reviewer"
export const NOTE_TEXT = "Review check: this pin marks the venue, 598 Broadway."
export const REVIEW_VIEW: ViewState = { ...DEFAULT_VIEW, sel: "bin:1007945" }
// The proxy's host name. Chrome resolves it to loopback, like a tailnet name.
export const PROXY_HOST = "review-proxy.test"
const WIDTH = 1600
const HEIGHT = 900
const REDIS_IMAGE = "redis:7-alpine"

const run = promisify(execFile)
const say = (text: string) => console.log(`[review] ${text}`)

// ---- what the reviewer receives ----

export type InboxMessage = { id: string; from: string; type: string; corr: string | null; body: unknown }

// `agent-mesh inbox` prints one line per message: `<id>  <from> -> <type> [<corr>]: <body JSON>`.
export function parseInbox(stdout: string): InboxMessage[] {
  const messages: InboxMessage[] = []
  for (const line of stdout.split("\n")) {
    const match = /^(\S+) {2}(\S+) -> (\S+?)(?: \[([^\]]*)\])?: (\{.*\})$/.exec(line)
    if (match == null) continue
    try {
      messages.push({ id: match[1]!, from: match[2]!, type: match[3]!, corr: match[4] ?? null, body: JSON.parse(match[5]!) })
    } catch {
      // Not a message line.
    }
  }
  return messages
}

export type NoteExpectation = { comment: string; origin: string; view: ViewState }

// Everything wrong with a received review note; empty when it holds. The pin goes
// on the centre of the viewport, where the camera's target, the venue, is drawn.
export function noteProblems(message: InboxMessage, expect: NoteExpectation): string[] {
  const problems: string[] = []
  if (message.type !== "note") problems.push(`the message is a ${message.type}, not a note`)
  if (message.corr !== "ui-review") problems.push(`the correlation id is ${message.corr ?? "missing"}, not ui-review`)
  const body = (typeof message.body === "object" && message.body != null ? message.body : {}) as Record<string, unknown>
  if (body.kind !== "ui-review-comment") problems.push(`the body kind is ${String(body.kind)}, not ui-review-comment`)
  if (body.comment !== expect.comment) problems.push(`the comment is ${JSON.stringify(body.comment)}`)
  let url: URL | null = null
  try {
    url = new URL(String(body.url))
  } catch {
    problems.push(`the page URL ${JSON.stringify(body.url)} is not a URL`)
  }
  if (url != null) {
    if (url.origin !== expect.origin) problems.push(`the page URL is on ${url.origin}, not ${expect.origin}`)
    if (!isDeepStrictEqual(parseViewState(url.hash), expect.view)) {
      problems.push(`the page URL's hash ${url.hash} is not the open view ${serializeViewState(expect.view)}`)
    }
  }
  const pin = body.pin as { n?: unknown; xPct?: unknown; yPct?: unknown } | null | undefined
  if (pin?.n !== 1) {
    problems.push("the note has no pin #1")
  } else if (Math.abs(Number(pin.xPct) - 50) > 2 || Math.abs(Number(pin.yPct) - 50) > 2) {
    problems.push(`the pin is at ${String(pin.xPct)}%, ${String(pin.yPct)}%, not on the venue at the centre`)
  }
  if (typeof body.screenshot !== "string" || body.screenshot === "") problems.push("the note has no screenshot")
  return problems
}

// Width and height of a PNG, or null when the bytes are not one.
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("latin1", 12, 16) !== "IHDR") {
    return null
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

// ---- a proxy that keeps its own Host header ----

// A stand-in for a proxy such as `tailscale serve`: it forwards every request and
// WebSocket upgrade to the dev server and keeps the browser's Host header, so the
// dev server sees the proxy's host name.
export async function startProxy(targetPort: number): Promise<Server> {
  const server = createHttpServer((req, res) => {
    const upstream = httpRequest(
      { host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })
  server.on("upgrade", (req, socket, head) => {
    const upstream = connect(targetPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`)
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on("error", () => socket.destroy())
    socket.on("error", () => upstream.destroy())
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  return server
}

// ---- processes, all stopped on the way out ----

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

const cleanups: Array<() => Promise<unknown>> = []
let stopping: Promise<void> | null = null

// Stops everything in the reverse order it started. Safe to call twice.
function stopAll(): Promise<void> {
  stopping ??= (async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {})
  })()
  return stopping
}

type Started = { name: string; child: ChildProcess; log: string }

// Each process leads its own process group, so stopping the group also stops the
// children that pnpm and Chrome start.
function startProcess(work: string, name: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Started {
  const log = join(work, `${name}.log`)
  const fd = openSync(log, "a")
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", fd, fd], detached: true })
  closeSync(fd)
  child.on("error", () => {})
  const started = { name, child, log }
  cleanups.push(() => stopGroup(child))
  return started
}

async function stopGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid == null) return
  const running = child.exitCode == null && child.signalCode == null
  const exited = running ? new Promise<void>((done) => child.once("exit", () => done())) : Promise.resolve()
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    return
  }
  await Promise.race([exited, sleep(5000)])
  await sleep(300)
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // The whole group is gone.
  }
}

function exited(started: Started): boolean {
  return started.child.exitCode != null || started.child.signalCode != null
}

function logTail(started: Started): string {
  try {
    return readFileSync(started.log, "utf8").trim().split("\n").slice(-15).join("\n")
  } catch {
    return "(no log)"
  }
}

// Polls `ready` until it answers true, failing early when `process` exits.
async function waitUntil(what: string, ready: () => Promise<boolean>, options: { timeoutMs: number; process?: Started }): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    if (await ready().catch(() => false)) return
    if (options.process != null && exited(options.process)) {
      throw new Error(`${options.process.name} exited while waiting for ${what}:\n${logTail(options.process)}`)
    }
    await sleep(250)
  }
  throw new Error(`timed out after ${options.timeoutMs} ms waiting for ${what}${options.process == null ? "" : `:\n${logTail(options.process)}`}`)
}

async function answers(url: string): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
  await res.body?.cancel()
  return res.ok
}

// ---- a browser tab over the DevTools protocol ----

class Tab {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      const waiter = message.id == null ? undefined : this.pending.get(message.id)
      if (waiter == null) return
      this.pending.delete(message.id!)
      if (message.error != null) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("the tab's DevTools connection closed"))
      this.pending.clear()
    })
  }

  static async open(cdpUrl: string): Promise<Tab> {
    const res = await fetch(`${cdpUrl}/json/new?about:blank`, { method: "PUT" })
    const target = (await res.json()) as { webSocketDebuggerUrl: string }
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((done, fail) => {
      socket.addEventListener("open", () => done(), { once: true })
      socket.addEventListener("error", () => fail(new Error(`cannot connect to the tab at ${cdpUrl}`)), { once: true })
    })
    return new Tab(socket)
  }

  send<T>(method: string, params: object = {}, timeoutMs = 15_000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} got no answer within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval<T>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.send<{
      result: { value?: unknown }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    if (exceptionDetails != null) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result.value as T
  }

  waitFor(expression: string, what: string, timeoutMs = 30_000): Promise<void> {
    return waitUntil(what, () => this.eval<boolean>(`Boolean(${expression})`), { timeoutMs })
  }

  // Real mouse input: sharing the tab needs a trusted user gesture.
  async click(at: { x: number; y: number }): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at })
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1 })
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1 })
  }

  close(): void {
    this.socket.close()
  }
}

// The overlay renders inside a shadow root. innerText skips hidden elements, so
// waiting on it waits for what the reviewer can see.
const OVERLAY = "document.querySelector('reviewer-overlay')?.shadowRoot"
const overlayText = `(${OVERLAY}?.querySelector('.root')?.innerText ?? '')`

async function centreOf(tab: Tab, selector: string): Promise<{ x: number; y: number }> {
  const at = await tab.eval<{ x: number; y: number } | null>(`(() => {
    const el = ${OVERLAY}?.querySelector(${JSON.stringify(selector)})
    if (el == null) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (at == null) throw new Error(`the overlay has no ${selector}`)
  return at
}

// ---- the run ----

async function startChrome(work: string, extraFlags: string[]): Promise<string> {
  const binary = findChrome()
  if (binary == null) throw new Error("no Chrome found; set CHROME to a Chrome or Chromium binary")
  const port = await freePort()
  // Some containers cannot use Chrome's sandbox: retry without it only when Chrome
  // exits during startup, and say so.
  for (const noSandbox of [false, true]) {
    const name = noSandbox ? "chrome-no-sandbox" : "chrome"
    const chrome = startProcess(work, name, binary, [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(work, name)}`,
      // Share this tab without a prompt, which headless Chrome cannot show.
      "--auto-accept-this-tab-capture",
      `--window-size=${WIDTH},${HEIGHT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      ...extraFlags,
      ...(noSandbox ? ["--no-sandbox"] : []),
      "about:blank",
    ], { cwd: work, env })
    try {
      await waitUntil("Chrome's DevTools", async () => (await devtoolsAnswering(port)) != null, { timeoutMs: 15_000, process: chrome })
      if (noSandbox) say("Chrome started with --no-sandbox (the sandbox is not available here)")
      return `http://127.0.0.1:${port}`
    } catch (error) {
      if (noSandbox) throw error
      await stopGroup(chrome.child)
    }
  }
  throw new Error(`Chrome did not start (${binary})`)
}

async function review(options: { viaProxy: boolean; out: string; work: string }): Promise<void> {
  const { work } = options
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const repoRoot = resolve(appDir, "../..")
  const meshDir = join(repoRoot, "agent-mesh")
  const runId = `${Date.now()}-${process.pid}`
  const [redisPort, overlayPort, devPort] = [await freePort(), await freePort(), await freePort()]

  say(`starting a throwaway Redis on 127.0.0.1:${redisPort}`)
  const redisName = `nyc-live-review-e2e-${runId}`
  await run("docker", ["run", "-d", "--rm", "--name", redisName, "-p", `127.0.0.1:${redisPort}:6379`, REDIS_IMAGE], { timeout: 120_000 })
  cleanups.push(() => run("docker", ["rm", "-f", redisName], { timeout: 30_000 }))
  await waitUntil("Redis", async () => (await run("docker", ["exec", redisName, "redis-cli", "ping"])).stdout.includes("PONG"), { timeoutMs: 15_000 })

  // Every mesh process gets a minimal environment, so ids, sockets and session
  // variables of the calling shell cannot reach the throwaway mesh.
  const meshEnv: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    HOME: env.HOME,
    ...(env.NODE_OPTIONS == null ? {} : { NODE_OPTIONS: env.NODE_OPTIONS }),
    AGENT_MESH_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    AGENT_MESH_HOME: join(work, "mesh-home"),
    AGENT_MESH_PREFIX: `review-e2e-${runId}`,
    AGENT_MESH_HOSTNAME: "review-e2e",
  }
  const tsx = join(meshDir, "node_modules/.bin/tsx")
  const mesh = (...args: string[]) => run(tsx, ["src/cli.ts", ...args], { cwd: meshDir, env: meshEnv, timeout: 30_000 })

  say("starting an agent-mesh daemon on it")
  const daemon = startProcess(work, "daemon", tsx, ["src/daemon.ts"], { cwd: meshDir, env: meshEnv })
  await waitUntil("the agent-mesh daemon", async () => (await mesh("health"), true), { timeoutMs: 30_000, process: daemon })
  await mesh("register", "--id", REVIEWER_ID, "--role", "reviewer", "--deliver", "none")
  say(`registered the reviewer agent (${REVIEWER_ID})`)

  const devOrigin = `http://127.0.0.1:${devPort}`
  let appOrigin = devOrigin
  const chromeFlags: string[] = []
  if (options.viaProxy) {
    const proxy = await startProxy(devPort)
    cleanups.push(() => new Promise<void>((done) => proxy.close(() => done())))
    appOrigin = `http://${PROXY_HOST}:${(proxy.address() as AddressInfo).port}`
    // getDisplayMedia needs a secure context; a proxy such as `tailscale serve` is HTTPS.
    chromeFlags.push(`--host-resolver-rules=MAP ${PROXY_HOST} 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${appOrigin}`)
    say(`proxy ${appOrigin} -> ${devOrigin}`)
  }

  // The two commands in the README's "Review it" section, with throwaway ports,
  // paths and mesh.
  say(`starting the overlay server on 127.0.0.1:${overlayPort} (pnpm overlay)`)
  const origins = options.viaProxy ? ["--origin", devOrigin, "--origin", appOrigin] : ["--origin", devOrigin]
  const meshCli = JSON.stringify(["pnpm", "--silent", "--dir", meshDir, "exec", "tsx", "src/cli.ts"])
  const overlay = startProcess(work, "overlay", "pnpm", [
    "--dir", repoRoot, "overlay",
    "--port", String(overlayPort),
    ...origins,
    "--target", REVIEWER_ID,
    "--plan", join(appDir, "plan/review-plan.json"),
    "--report-dir", join(work, "reports"),
    "--mesh-cli", meshCli,
  ], { cwd: repoRoot, env: meshEnv })
  await waitUntil("the overlay server", () => answers(`http://127.0.0.1:${overlayPort}/api/review`), { timeoutMs: 90_000, process: overlay })

  say(`starting the dev server on ${devOrigin} (NYC_LIVE_OVERLAY=http://127.0.0.1:${overlayPort} pnpm dev)`)
  const appEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("AGENT_MESH_")))
  const dev = startProcess(work, "dev", "pnpm", ["--dir", appDir, "dev"], {
    cwd: appDir,
    env: {
      ...appEnv,
      NYC_LIVE_PORT: String(devPort),
      NYC_LIVE_OVERLAY: `http://127.0.0.1:${overlayPort}`,
      NYC_LIVE_ALLOWED_HOSTS: options.viaProxy ? PROXY_HOST : "",
    },
  })
  await waitUntil("the dev server", () => answers(`${devOrigin}/`), { timeoutMs: 60_000, process: dev })
  await waitUntil("the overlay script on the app's origin", () => answers(`${appOrigin}/reviewer-overlay.js`), { timeoutMs: 15_000 })

  say("starting headless Chrome with tab capture")
  const cdpUrl = await startChrome(work, chromeFlags)
  const tab = await Tab.open(cdpUrl)
  cleanups.push(async () => tab.close())

  const hash = serializeViewState(REVIEW_VIEW)
  say(`opening ${appOrigin}/${hash}`)
  await tab.send("Page.enable")
  await tab.send("Page.navigate", { url: `${appOrigin}/${hash}` })
  await tab.waitFor("window.__nycLive?.ready === true", "the app to report ready", 60_000)
  await tab.waitFor(`${OVERLAY}?.querySelector('.bubble') != null`, "the Reviewer button")

  await tab.click(await centreOf(tab, ".bubble"))
  await tab.waitFor(`${overlayText}.includes('Add comment')`, "the Reviewer panel")
  say("Reviewer panel open")

  await tab.click(await centreOf(tab, ".panel-foot .btn.primary"))
  await tab.waitFor(`${overlayText}.includes('Click the page to drop a pin')`, "comment mode")
  // Sharing starts with comment mode; give the stream a moment, then make sure it did.
  await sleep(1500)
  const captureOff = await tab.eval<boolean>(`${overlayText}.includes('Screen capture is off')`)
  if (captureOff) throw new Error(`tab capture did not start: ${await tab.eval<string>(overlayText)}`)
  say("comment mode on, tab shared")

  // The camera looks at the venue, so the venue is drawn at the centre of the viewport.
  const viewport = await tab.eval<{ w: number; h: number }>("({ w: innerWidth, h: innerHeight })")
  await tab.click({ x: Math.round(viewport.w / 2), y: Math.round(viewport.h / 2) })
  await tab.waitFor(`${overlayText}.includes('Pin #1')`, "pin #1")
  say(`pin #1 dropped on the venue (${Math.round(viewport.w / 2)}, ${Math.round(viewport.h / 2)})`)

  await tab.click(await centreOf(tab, ".composer textarea"))
  await tab.send("Input.insertText", { text: NOTE_TEXT })
  await tab.click(await centreOf(tab, ".composer .btn.primary"))
  await tab.waitFor(`/Sent to |Not delivered|Cannot reach/.test(${overlayText})`, "the overlay to send the note")
  const status = await tab.eval<string>(`${OVERLAY}.querySelector('.toolbar .status')?.textContent ?? ''`)
  say(`overlay: ${status}`)
  if (!status.startsWith(`Sent to ${REVIEWER_ID} with a screenshot`)) {
    throw new Error(`the note was not sent with a screenshot:\n${logTail(overlay)}`)
  }

  say(`reading ${REVIEWER_ID}'s inbox`)
  let note: InboxMessage | undefined
  await waitUntil("the note in the reviewer's inbox", async () => {
    note = parseInbox((await mesh("inbox", "--id", REVIEWER_ID)).stdout).find((m) => m.corr === "ui-review")
    return note != null
  }, { timeoutMs: 15_000 })
  const problems = noteProblems(note!, { comment: NOTE_TEXT, origin: appOrigin, view: REVIEW_VIEW })
  const body = note!.body as { url: string; pin: { xPct: number; yPct: number }; screenshot: string }
  const png = problems.length === 0 ? readFileSync(body.screenshot) : null
  const size = png == null ? null : pngSize(png)
  if (png != null && size == null) problems.push("the screenshot is not a PNG")
  if (problems.length > 0) throw new Error(`the note does not hold:\n  ${problems.join("\n  ")}`)

  mkdirSync(dirname(options.out), { recursive: true })
  copyFileSync(body.screenshot, options.out)
  say(`note ${note!.id} from ${note!.from}: comment, page URL ${new URL(body.url).hash}, pin #1 at ${body.pin.xPct}%, ${body.pin.yPct}%`)
  say(`screenshot ${size!.width}x${size!.height}, saved to ${options.out}`)
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "via-proxy": { type: "boolean", default: false },
      out: { type: "string", default: "shots/review-note.png" },
      "env-file": { type: "string" },
      record: { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
    },
  })
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const out = resolve(values.out)
  const work = mkdtempSync(join(tmpdir(), "nyc-live-review-e2e-"))
  cleanups.push(async () => {
    if (values.keep) say(`work directory kept: ${work}`)
    else rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  const interrupted = () => void stopAll().finally(() => process.exit(130))
  process.once("SIGINT", interrupted)
  process.once("SIGTERM", interrupted)

  try {
    await review({ viaProxy: values["via-proxy"], out, work })
  } catch (error) {
    console.error(`[review] FAIL: ${(error as Error).message}`)
    return 1
  } finally {
    say("stopping everything it started")
    await stopAll()
  }

  say("check:visual on the received screenshot")
  const check = spawn(process.execPath, [
    join(appDir, "scripts/check-visual.ts"),
    out,
    join(appDir, "checks/review-note.json"),
    ...(values["env-file"] == null ? [] : ["--env-file", resolve(values["env-file"])]),
    ...(values.record ? ["--record"] : []),
  ], { cwd: appDir, stdio: "inherit" })
  const code = await new Promise<number | null>((done) => check.once("exit", done))
  if (code !== 0) {
    console.error("[review] FAIL: the screenshot does not pass checks/review-note.json")
    return 1
  }
  say("PASS")
  return 0
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main())
}
