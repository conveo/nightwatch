// Proves, end to end, that a person can review ghent-live with the reviewer overlay
// (../../reviewer-overlay): pin a spot, write a note, and have it reach an agent's
// mesh inbox with the page URL and a screenshot.
//
//   node scripts/review-e2e.ts --env-file <file with OPENAI_API_KEY>
//   CHROME_FLAGS=--no-sandbox node scripts/review-e2e.ts --env-file <file>
//
// Everything it needs it starts itself, on free ports, and stops again by PID when
// it ends, on failure too:
//   - a throwaway Redis (a Docker container) and an agent-mesh daemon on it, with
//     AGENT_MESH_HOME in a short /tmp directory and a minimal environment, so no id,
//     socket or session from the calling shell can reach a mesh that is already
//     running; a reviewer agent, `reviewer`, is registered there;
//   - the overlay server, for the app's origin and a proxy's origin;
//   - a dev server with GHENT_LIVE_OVERLAY, and with GHENT_LIVE_ALLOWED_HOSTS naming
//     the proxy's host;
//   - its own short-lived headless Chrome, which accepts tab capture (the shared
//     browser cannot) and resolves the proxy's host name to the dev server, so the
//     dev server sees the Host and Origin a proxy such as `tailscale serve` sends.
// Then, once on the app's own origin and once through the proxy's, it opens the
// review view (the default view at night, the Belfry selected), opens the Reviewer
// panel, drops a pin on the red ring, sends a note and reads the reviewer's inbox.
//
// It exits 0 only when each note carries the comment, a page URL whose hash parses to
// the view that was open, and a screenshot that shows the scene and the pin, and when
// check:visual passes checks/review-note.json on the first note's screenshot. Exit
// 1 means a check failed, 2 that the run could not start.
//
//   --env-file <path>     key for check:visual (or OPENAI_API_KEY in the environment)
//   --record              also save check:visual's answers under test/recordings/
//   --out <png>           where the first note's screenshot is copied
//                         (default shots/review-note.png; the proxy's gets "-proxy")
//   --keep                keep the work directory (logs, reports) for inspection
//   CHROME, CHROME_FLAGS  a Chrome binary, and extra flags for it ("--no-sandbox"
//                         where Chrome's sandbox cannot start)

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { once } from "node:events"
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { createServer } from "node:net"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import process, { env } from "node:process"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { inflateSync } from "node:zlib"
import { DEFAULT_VIEW, parseViewState, serializeViewState, type Vec3, type ViewState } from "../src/view-state.ts"
import { findChrome } from "./chrome.ts"

// ---- the review: what is opened, where the pin goes, what the note must carry ----

// The default view at night with the Belfry selected: the base app's red ring is in
// the middle of the screen, so the check holds with or without the other layers.
export const REVIEW_VIEW: ViewState = { ...DEFAULT_VIEW, light: "night", sel: "place:belfort" }
export const REVIEW_HASH = serializeViewState(REVIEW_VIEW)

export const REVIEWER_ID = "reviewer"
export const REPORTER_ID = "reviewer-overlay"
export const PROXY_HOST = "review-proxy.test"
export const CORRELATION_ID = "ui-review"

// The origin layer's ring (src/layers/origin.ts) spans 26 to 34 m around the Belfry,
// 0.6 m above the ground; the pin goes on the middle of its band.
const RING_RADIUS_M = 30
const RING_Y_M = 0.6
// main.ts's camera.
const FOV_DEG = 45
// The overlay's pin (reviewer-overlay/src/client/annotate.ts): a round head of this
// radius whose centre sits 1.9 radii above the tip.
const PIN_RADIUS_PX = 14
const WINDOW = { w: 1280, h: 800 }
// Ports the run reserves for itself, and the range its workers' dev servers use.
const RESERVED_PORTS = new Set([4858, 5280, 5281, 5290, 9343])
const WORKER_PORTS = { from: 5302, to: 5320 }

export type Point2 = { x: number; y: number }
export type Viewport = { w: number; h: number; dpr: number }

// Where a world point lands on the screen, in CSS pixels, for main.ts's camera
// (a PerspectiveCamera looking from `cam` at `tgt`, up +y). Null behind the camera.
export function projectToScreen(view: Pick<ViewState, "cam" | "tgt">, point: Vec3, viewport: { w: number; h: number }): Point2 | null {
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const unit = (a: Vec3): Vec3 => {
    const length = Math.hypot(...a)
    return [a[0] / length, a[1] / length, a[2] / length]
  }
  const forward = unit(sub(view.tgt, view.cam))
  const right = unit(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  const d = sub(point, view.cam)
  const depth = dot(d, forward)
  if (depth <= 0) return null
  const tan = Math.tan((FOV_DEG * Math.PI) / 360)
  const ndcX = dot(d, right) / (depth * tan * (viewport.w / viewport.h))
  const ndcY = dot(d, up) / (depth * tan)
  return { x: ((ndcX + 1) / 2) * viewport.w, y: ((1 - ndcY) / 2) * viewport.h }
}

// Points on the ring's band, all the way round, in screen pixels.
export function ringPoints(view: ViewState, viewport: { w: number; h: number }, count = 24): Point2[] {
  const points: Point2[] = []
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count
    const p = projectToScreen(view, [RING_RADIUS_M * Math.cos(angle), RING_Y_M, RING_RADIUS_M * Math.sin(angle)], viewport)
    if (p != null && p.x >= 0 && p.y >= 0 && p.x < viewport.w && p.y < viewport.h) points.push(p)
  }
  return points
}

export function pinHead(tip: Point2): Point2 {
  return { x: tip.x, y: tip.y - PIN_RADIUS_PX * 1.9 }
}

// The hash rounds positions to 0.1 m, so a camera within 0.06 m is the same camera.
export function sameView(a: ViewState, b: ViewState): boolean {
  const near = (u: Vec3, v: Vec3) => u.every((n, i) => Math.abs(n - v[i]!) < 0.06)
  return (
    near(a.cam, b.cam) &&
    near(a.tgt, b.tgt) &&
    a.sel === b.sel &&
    a.mode === b.mode &&
    a.t === b.t &&
    a.light === b.light &&
    a.ask === b.ask &&
    JSON.stringify(a.layers) === JSON.stringify(b.layers)
  )
}

// ---- PNG, just enough to read the screenshots' pixels ----

export type Image = { width: number; height: number; channels: number; data: Uint8Array }
export type Rgb = [number, number, number]

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 24 && PNG_SIGNATURE.equals(bytes.subarray(0, 8))
}

// 8-bit RGB or RGBA, not interlaced: what Chrome writes for a screenshot or a canvas.
export function decodePng(bytes: Buffer): Image {
  if (!isPng(bytes)) throw new Error("not a PNG")
  let width = 0
  let height = 0
  let header: number[] = []
  const chunks: Buffer[] = []
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString("latin1", at + 4, at + 8)
    const data = bytes.subarray(at + 8, at + 8 + length)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      header = [data[8]!, data[9]!, data[12]!]
    } else if (type === "IDAT") chunks.push(data)
    else if (type === "IEND") break
    at += 12 + length
  }
  const [depth, colourType, interlace] = header
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0
  if (depth !== 8 || channels === 0 || interlace !== 0) {
    throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${colourType}, interlace ${interlace})`)
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  if (raw.length < height * (stride + 1)) throw new Error("truncated PNG")
  const out = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = y * (stride + 1) + 1
    const row = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[row + i - channels]! : 0
      const b = y > 0 ? out[row - stride + i]! : 0
      const c = i >= channels && y > 0 ? out[row - stride + i - channels]! : 0
      let predicted: number
      if (filter === 0) predicted = 0
      else if (filter === 1) predicted = a
      else if (filter === 2) predicted = b
      else if (filter === 3) predicted = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else throw new Error(`bad PNG filter ${filter} on row ${y}`)
      out[row + i] = (raw[line + i]! + predicted) & 0xff
    }
  }
  return { width, height, channels, data: out }
}

export function pixel(image: Image, x: number, y: number): Rgb {
  const px = Math.min(image.width - 1, Math.max(0, Math.round(x)))
  const py = Math.min(image.height - 1, Math.max(0, Math.round(y)))
  const at = (py * image.width + px) * image.channels
  return [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!]
}

// The ring (#ff3b30), with room for a tab capture's colour conversion.
export const isRingRed = ([r, g, b]: Rgb) => r >= 150 && r - g >= 70 && r - b >= 70
// The pin's fill (#ea580c), or anything as warm.
export const isWarm = ([r, , b]: Rgb) => r >= 170 && r - b >= 100

// The share of pixels inside a circle (in CSS pixels, scaled to the image) that pass.
export function shareInCircle(image: Image, centre: Point2, radius: number, scale: number, test: (rgb: Rgb) => boolean): number {
  let inside = 0
  let passing = 0
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue
      inside++
      if (test(pixel(image, (centre.x + dx) * scale, (centre.y + dy) * scale))) passing++
    }
  }
  return inside === 0 ? 0 : passing / inside
}

// Where to drop the pin: the ring point nearest the viewer that is red on screen.
export function choosePinTip(before: Image, view: ViewState, viewport: { w: number; h: number }): { tip: Point2 | null; red: Point2[] } {
  const scale = before.width / viewport.w
  const red = ringPoints(view, viewport).filter((p) => isRingRed(pixel(before, p.x * scale, p.y * scale)))
  const tip = red.reduce<Point2 | null>((best, p) => (best == null || p.y > best.y ? p : best), null)
  return { tip, red }
}

// What the note's screenshot must show: the ring where it was before the pin (so the
// capture is the rendered scene, not a blank or black frame, and lines up with the
// page), and the pin's head filled in above the tip.
export function screenshotProblems(args: { before: Image; after: Image; viewport: { w: number; h: number }; tip: Point2; red: Point2[] }): string[] {
  const { before, after, viewport, tip, red } = args
  const problems: string[] = []
  const scale = after.width / viewport.w
  const head = pinHead(tip)
  const away = red.filter((p) => Math.hypot(p.x - head.x, p.y - head.y) > PIN_RADIUS_PX + 10 && Math.hypot(p.x - tip.x, p.y - tip.y) > 10)
  const kept = away.filter((p) => isRingRed(pixel(after, p.x * scale, p.y * scale)))
  if (away.length < 3 || kept.length < 0.75 * away.length) {
    problems.push(`the screenshot does not show the red ring (${kept.length} of ${away.length} ring points are red)`)
  }
  const pinBefore = shareInCircle(before, head, PIN_RADIUS_PX - 5, before.width / viewport.w, isWarm)
  const pinAfter = shareInCircle(after, head, PIN_RADIUS_PX - 5, scale, isWarm)
  if (pinAfter < 0.6 || pinAfter - pinBefore < 0.4) {
    problems.push(`the screenshot has no pin above the tip (${Math.round(pinAfter * 100)}% of its head is pin-coloured, ${Math.round(pinBefore * 100)}% before)`)
  }
  return problems
}

// ---- the note, as the reviewer's inbox prints it ----

export type InboxMessage = { id: string; from: string; type: string; correlationId: string | null; body: unknown }

// One line of `agent-mesh inbox`: `<id>  <from> -> <type> [<corr>]: <body as JSON>`.
export function parseInboxLine(line: string): InboxMessage | null {
  const match = /^(\S+) {2}(\S+) -> (\S+)(?: \[([^\]]*)\])?: (.*)$/.exec(line)
  if (match == null) return null
  try {
    return { id: match[1]!, from: match[2]!, type: match[3]!, correlationId: match[4] ?? null, body: JSON.parse(match[5]!) }
  } catch {
    return null
  }
}

type NoteBody = {
  kind?: unknown
  comment?: unknown
  url?: unknown
  pin?: { n?: unknown; xPct?: unknown; yPct?: unknown } | null
  screenshot?: unknown
  meta?: { viewport?: { w?: unknown; h?: unknown; dpr?: unknown } } | null
}

export type NoteExpectation = { comment: string; origin: string; view: ViewState; viewport: Viewport; tip: Point2 }

// Everything wrong with a delivered note; empty when it carries what a review needs.
export function noteProblems(message: InboxMessage, expected: NoteExpectation): string[] {
  const problems: string[] = []
  if (message.type !== "note") problems.push(`the message is a ${message.type}, not a note`)
  if (message.correlationId !== CORRELATION_ID) problems.push(`the correlation id is ${message.correlationId}, not ${CORRELATION_ID}`)
  if (message.from !== REPORTER_ID) problems.push(`the note comes from ${message.from}, not ${REPORTER_ID}`)
  const body = (typeof message.body === "object" && message.body != null ? message.body : {}) as NoteBody
  if (body.kind !== "ui-review-comment") problems.push(`the body's kind is ${JSON.stringify(body.kind)}, not "ui-review-comment"`)
  if (body.comment !== expected.comment) problems.push(`the comment is ${JSON.stringify(body.comment)}, not ${JSON.stringify(expected.comment)}`)

  let url: URL | null = null
  try {
    url = new URL(String(body.url))
  } catch {
    problems.push(`the page url ${JSON.stringify(body.url)} is not a URL`)
  }
  if (url != null) {
    if (url.origin !== expected.origin) problems.push(`the page url is on ${url.origin}, not ${expected.origin}`)
    const view = parseViewState(url.hash)
    if (!sameView(view, expected.view)) {
      problems.push(`the page url's hash ${url.hash} parses to ${serializeViewState(view)}, not the view that was open, ${serializeViewState(expected.view)}`)
    }
  }

  const pin = body.pin
  const xPct = (expected.tip.x / expected.viewport.w) * 100
  const yPct = (expected.tip.y / expected.viewport.h) * 100
  if (pin == null || typeof pin.n !== "number" || pin.n < 1) problems.push("the note has no numbered pin")
  else if (typeof pin.xPct !== "number" || typeof pin.yPct !== "number" || Math.abs(pin.xPct - xPct) > 0.5 || Math.abs(pin.yPct - yPct) > 0.5) {
    problems.push(`the pin is at ${String(pin.xPct)}%, ${String(pin.yPct)}%, not on the ring at ${xPct.toFixed(1)}%, ${yPct.toFixed(1)}%`)
  }

  const shown = body.meta?.viewport
  if (shown?.w !== expected.viewport.w || shown?.h !== expected.viewport.h) {
    problems.push(`the note's viewport is ${String(shown?.w)}x${String(shown?.h)}, not ${expected.viewport.w}x${expected.viewport.h}`)
  }

  if (typeof body.screenshot !== "string" || !isAbsolute(body.screenshot)) {
    problems.push("the note has no screenshot (the tab capture failed)")
  } else if (!existsSync(body.screenshot)) {
    problems.push("the note's screenshot file does not exist")
  } else {
    const png = readFileSync(body.screenshot)
    if (!isPng(png)) problems.push("the note's screenshot is not a PNG")
    else {
      const w = png.readUInt32BE(16)
      const h = png.readUInt32BE(20)
      const dpr = expected.viewport.dpr
      if (Math.abs(w - expected.viewport.w * dpr) > 2 || Math.abs(h - expected.viewport.h * dpr) > 2) {
        problems.push(`the screenshot is ${w}x${h}, not the ${expected.viewport.w}x${expected.viewport.h} viewport`)
      }
    }
  }
  return problems
}

// ---- environments ----

// Every mesh process (daemon, CLI, overlay server) gets only these variables. The
// calling shell's AGENT_MESH_HOME, AGENT_MESH_ID, AGENT_MESH_SOCK, HERDR_* and
// CLAUDE_CODE_* point at the mesh that is already running; inherited, they would
// register the test reviewer there.
export function meshEnvironment(base: NodeJS.ProcessEnv, mesh: { redisUrl: string; home: string; prefix: string }): Record<string, string> {
  const out: Record<string, string> = {
    AGENT_MESH_REDIS_URL: mesh.redisUrl,
    AGENT_MESH_HOME: mesh.home,
    AGENT_MESH_PREFIX: mesh.prefix,
    AGENT_MESH_HOSTNAME: "review-e2e",
  }
  for (const name of ["PATH", "HOME", "LANG", "UV_USE_IO_URING"]) {
    const value = base[name]
    if (value != null) out[name] = value
  }
  return out
}

// The dev server needs no mesh and no key: drop both, set the overlay and the proxy.
export function appEnvironment(base: NodeJS.ProcessEnv, settings: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value == null || /^(AGENT_MESH_|HERDR_|CLAUDE_CODE_|CODEX_)/.test(name)) continue
    if (name === "OPENAI_API_KEY" || name === "GHENT_LIVE_CDP") continue
    out[name] = value
  }
  return { ...out, ...settings }
}

// A Unix socket path may not exceed 108 bytes (107 and the terminating NUL).
export function socketPathFits(meshHome: string): boolean {
  return Buffer.byteLength(join(meshHome, "daemon.sock")) <= 107
}

export function portAllowed(port: number): boolean {
  return !RESERVED_PORTS.has(port) && (port < WORKER_PORTS.from || port > WORKER_PORTS.to)
}

// ---- the run ----

const APP_DIR = resolve(import.meta.dirname, "..")
const REPO_DIR = resolve(APP_DIR, "../..")
const AGENT_MESH_DIR = join(REPO_DIR, "agent-mesh")
const OVERLAY_DIR = join(REPO_DIR, "reviewer-overlay")
const TSX_CLI = join(REPO_DIR, "node_modules/tsx/dist/cli.mjs")
const MESH_CLI = join(AGENT_MESH_DIR, "src/cli.ts")
const VITE_BIN = join(APP_DIR, "node_modules/vite/bin/vite.js")

class SetupError extends Error {}

const say = (line: string) => console.log(`[review-e2e] ${line}`)

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const server = createServer()
    await new Promise<void>((done, fail) => {
      server.once("error", fail)
      server.listen(0, "127.0.0.1", () => done())
    })
    const address = server.address()
    await new Promise<void>((done) => server.close(() => done()))
    if (address != null && typeof address === "object" && portAllowed(address.port)) return address.port
  }
  throw new SetupError("no free port")
}

async function waitUntil<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe().catch(() => null)
    if (value != null && value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`)
    await sleep(200)
  }
}

// Everything started is stopped in reverse order, by its PID, on success and failure.
const cleanups: Array<() => Promise<void> | void> = []
async function cleanUp(): Promise<void> {
  while (cleanups.length > 0) {
    try {
      await cleanups.pop()!()
    } catch (error) {
      console.error(`[review-e2e] cleanup: ${(error as Error).message}`)
    }
  }
}

type Started = { name: string; child: ChildProcess; log: string; stopped: boolean }

// Each process leads its own process group, so stopping the group by the PID we saved
// also stops the children it started (vite's esbuild, Chrome's renderers).
async function stop(started: Started): Promise<void> {
  const { child, name } = started
  const pid = child.pid
  if (pid == null || started.stopped) return
  started.stopped = true
  if (child.exitCode == null && child.signalCode == null) {
    const exited = once(child, "exit")
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      return
    }
    await Promise.race([exited, sleep(5000)])
  }
  try {
    process.kill(-pid, 0)
    process.kill(-pid, "SIGKILL")
  } catch {
    // The whole group is gone.
  }
  say(`stopped ${name} (pid ${pid})`)
}

async function start(name: string, command: string, args: string[], options: { cwd: string; env: Record<string, string>; log: string }): Promise<Started> {
  const out = openSync(options.log, "a")
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", out, out] })
  closeSync(out)
  await once(child, "spawn")
  const started: Started = { name, child, log: options.log, stopped: false }
  cleanups.push(() => stop(started))
  say(`started ${name} (pid ${child.pid})`)
  return started
}

function tail(file: string, lines = 15): string {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n")
  } catch {
    return "(no log)"
  }
}

// The status code the dev server answers with for a given Host header.
function statusForHost(port: number, host: string): Promise<number> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/", headers: { host } }, (res) => {
      res.resume()
      done(res.statusCode ?? 0)
    })
    req.on("error", fail)
    req.end()
  })
}

// ---- Chrome over the DevTools protocol (scripts/chrome.ts keeps its client private) ----

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

class Cdp {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
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
      for (const waiter of this.pending.values()) waiter.reject(new Error("the DevTools connection closed"))
      this.pending.clear()
    })
  }

  static async connect(cdpUrl: string): Promise<Cdp> {
    const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string }
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise<void>((done, fail) => {
      socket.addEventListener("open", () => done(), { once: true })
      socket.addEventListener("error", () => fail(new Error(`cannot connect to ${cdpUrl}`)), { once: true })
    })
    return new Cdp(socket)
  }

  send<T>(method: string, params: object = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${method}: the DevTools connection is closed`))
    const id = this.nextId++
    return new Promise<T>((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        fail(new Error(`${method} got no answer within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          done(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          fail(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId != null ? { sessionId } : {}) }))
    })
  }

  close(): void {
    this.socket.close()
  }
}

type Tab = { cdp: Cdp; sessionId: string }

async function evaluate<T>(tab: Tab, expression: string): Promise<T> {
  const answer = await tab.cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    tab.sessionId,
  )
  if (answer.exceptionDetails != null) throw new Error(`page script failed: ${answer.exceptionDetails.text}`)
  return answer.result.value as T
}

// Real mouse input: sharing a tab needs a trusted user gesture.
async function click(tab: Tab, at: Point2): Promise<void> {
  const base = { x: at.x, y: at.y, button: "left", clickCount: 1 }
  await tab.cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none", clickCount: 0 }, tab.sessionId)
  await tab.cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, tab.sessionId)
  await tab.cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" }, tab.sessionId)
}

const SHADOW = "document.querySelector('reviewer-overlay')?.shadowRoot"
const OVERLAY_TEXT = `(${SHADOW}?.querySelector('.root')?.innerText ?? '')`
const VIEWPORT = "({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })"
// The centre of an element in the overlay, or null while it is hidden or something
// else (another part of the overlay) lies on top of that spot.
const centreOf = (selector: string) =>
  `(() => { const root = ${SHADOW}; const el = root?.querySelector(${JSON.stringify(selector)}); if (el == null) return null; const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const top = root.elementFromPoint(x, y); return r.width > 0 && r.height > 0 && top != null && el.contains(top) ? { x, y } : null })()`

async function clickOverlay(tab: Tab, selector: string, what: string): Promise<void> {
  const at = await waitUntil(`${what} (shown, not covered)`, 10_000, () => evaluate<Point2 | null>(tab, centreOf(selector)))
  await click(tab, at)
}

async function waitForText(tab: Tab, pattern: RegExp, what: string, timeoutMs = 15_000): Promise<string> {
  return waitUntil(what, timeoutMs, async () => {
    const text = await evaluate<string>(tab, OVERLAY_TEXT)
    return pattern.exec(text)?.[0] ?? null
  })
}

type Mesh = { env: Record<string, string> }

function meshCli(mesh: Mesh, ...args: string[]) {
  return spawnSync(process.execPath, [TSX_CLI, MESH_CLI, ...args], { env: mesh.env, encoding: "utf8", timeout: 30_000 })
}

type PassResult = { problems: string[]; screenshot: string | null }

// One review, on one origin: open the view, pin the ring, send a note, read the inbox.
async function reviewOnce(args: { cdpUrl: string; origin: string; label: string; comment: string; mesh: Mesh; out: string; work: string }): Promise<PassResult> {
  const cdp = await Cdp.connect(args.cdpUrl)
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
  const tab: Tab = { cdp, sessionId }
  try {
    return await drive(tab, args)
  } catch (error) {
    // Say what the reviewer would have seen, and keep a picture of it.
    const text = await evaluate<string>(tab, OVERLAY_TEXT).catch(() => "")
    const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId).catch(() => null)
    const file = join(args.work, `failure-${args.label.replaceAll(" ", "-")}.png`)
    if (shot != null) writeFileSync(file, Buffer.from(shot.data, "base64"))
    throw new Error(`${args.label}: ${(error as Error).message}; the overlay showed: ${JSON.stringify(text.replaceAll(/\s+/g, " ").slice(0, 300))}`)
  } finally {
    await cdp.send("Target.closeTarget", { targetId }, undefined, 5_000).catch(() => {})
    cdp.close()
  }
}

async function drive(tab: Tab, args: { origin: string; label: string; comment: string; mesh: Mesh; out: string }): Promise<PassResult> {
  const { origin, comment, mesh } = args
  const { cdp, sessionId } = tab
  {
    await cdp.send("Page.enable", {}, sessionId)
    await cdp.send("Page.navigate", { url: `${origin}/${REVIEW_HASH}` }, sessionId)
    await waitUntil("the app to report ready with the overlay on the page", 90_000, () =>
      evaluate<boolean>(tab, `window.__ghentLive?.ready === true && ${SHADOW}?.querySelector('.bubble') != null`),
    )
    const opened = await evaluate<ViewState>(tab, "window.__ghentLive.view")
    if (!sameView(opened, REVIEW_VIEW)) return { problems: [`the app opened ${serializeViewState(opened)}, not ${REVIEW_HASH}`], screenshot: null }

    await clickOverlay(tab, ".bubble", "the Reviewer button")
    await waitForText(tab, /Add comment/, "the Reviewer panel")
    say(`${args.label}: Reviewer panel open`)
    await clickOverlay(tab, ".panel-foot .btn.primary", "the Add comment button")
    await waitForText(tab, /Click the page to drop a pin|Screen capture is off[^\n]*/, "comment mode")
    // Out of the way of the note's composer, as a reviewer would.
    await clickOverlay(tab, '.panel-head .icon-btn[aria-label="Close reviewer"]', "the panel's close button")
    // Comment mode starts sharing the tab, and Chrome's "sharing this tab" bar takes
    // its height from the page: wait until the viewport stops changing.
    let viewport = await evaluate<Viewport>(tab, VIEWPORT)
    for (let still = 0; still < 5; ) {
      await sleep(300)
      const now = await evaluate<Viewport>(tab, VIEWPORT)
      still = now.w === viewport.w && now.h === viewport.h ? still + 1 : 0
      viewport = now
    }
    const off = /Screen capture is off[^\n]*/.exec(await evaluate<string>(tab, OVERLAY_TEXT))
    if (off != null) return { problems: [off[0]], screenshot: null }
    say(`${args.label}: comment mode on, viewport ${viewport.w}x${viewport.h}`)

    // The ring as the page draws it now, before the pin.
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId)
    const before = decodePng(Buffer.from(data, "base64"))
    const { tip, red } = choosePinTip(before, REVIEW_VIEW, viewport)
    if (tip == null) return { problems: ["the red ring is not visible in the review view"], screenshot: null }

    await click(tab, tip)
    const pinLabel = await waitForText(tab, /Pin #\d+/, "the pin")
    say(`${args.label}: ${pinLabel} dropped on the red ring at ${Math.round(tip.x)},${Math.round(tip.y)}`)
    await clickOverlay(tab, ".composer textarea", "the note's text box")
    await cdp.send("Input.insertText", { text: comment }, sessionId)
    const typed = await evaluate<string>(tab, `${SHADOW}?.querySelector('.composer textarea')?.value ?? ''`)
    if (typed !== comment) return { problems: [`the note's text box holds ${JSON.stringify(typed)}`], screenshot: null }
    const open = await evaluate<ViewState>(tab, "window.__ghentLive.view")

    await clickOverlay(tab, ".composer .btn.primary", "the Send button")
    const status = await waitForText(tab, /(Sent to|Not delivered|Cannot reach)[^\n]*/, "the overlay to send the note", 30_000)
    say(`${args.label}: overlay says "${status}"`)
    const sent = /^Sent to (\S+) with a screenshot \(message (\S+)\)/.exec(status)
    if (sent == null || sent[1] !== REVIEWER_ID) return { problems: [`the overlay did not send the note with a screenshot: ${status}`], screenshot: null }

    const message = await waitUntil("the note in the reviewer's inbox", 20_000, async () => {
      const read = meshCli(mesh, "inbox", "--id", REVIEWER_ID)
      if (read.status !== 0) throw new Error(read.stderr)
      return read.stdout.split("\n").map(parseInboxLine).find((m) => m?.correlationId === CORRELATION_ID) ?? null
    })
    say(`${args.label}: the reviewer's inbox holds note ${message.id} from ${message.from}`)
    const problems = noteProblems(message, { comment, origin, view: open, viewport, tip })
    if (message.id !== sent[2]) problems.push(`the inbox's note is ${message.id}, the overlay sent ${sent[2]}`)
    const shot = (message.body as NoteBody).screenshot
    if (typeof shot !== "string" || !existsSync(shot)) return { problems, screenshot: null }

    mkdirSync(dirname(args.out), { recursive: true })
    copyFileSync(shot, args.out)
    problems.push(...screenshotProblems({ before, after: decodePng(readFileSync(shot)), viewport, tip, red }))
    return { problems, screenshot: args.out }
  }
}

async function launchChrome(args: { work: string; extraFlags: string[]; proxyOrigin: string }): Promise<string> {
  const binary = findChrome()
  if (binary == null) throw new SetupError("no Chrome found; set CHROME to a Chrome or Chromium binary")
  const attempts = args.extraFlags.includes("--no-sandbox") ? [args.extraFlags] : [args.extraFlags, [...args.extraFlags, "--no-sandbox"]]
  for (const flags of attempts) {
    const port = await freePort()
    const profile = mkdtempSync(join(args.work, "chrome-"))
    const chrome = await start("Chrome", binary, [
      "--headless=new",
      ...flags,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      // Accepts the tab-sharing prompt the overlay opens; the shared browser lacks it.
      "--auto-accept-this-tab-capture",
      `--window-size=${WINDOW.w},${WINDOW.h}`,
      // The proxy's host name reaches the dev server, and counts as a secure context
      // as an https proxy would, so the page may still share its tab.
      `--host-resolver-rules=MAP ${PROXY_HOST} 127.0.0.1`,
      `--unsafely-treat-insecure-origin-as-secure=${args.proxyOrigin}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "about:blank",
    ], { cwd: args.work, env: appEnvironment(env, {}), log: join(args.work, "chrome.log") })
    const cdpUrl = `http://127.0.0.1:${port}`
    const answering = await waitUntil("Chrome's DevTools", 15_000, async () => {
      if (chrome.child.exitCode != null || chrome.child.signalCode != null) return "exited"
      const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1000) })
      return res.ok ? "up" : null
    }).catch(() => "exited")
    if (answering === "up") {
      if (flags !== args.extraFlags) say("Chrome started with --no-sandbox (its sandbox is not available here)")
      return cdpUrl
    }
    await stop(chrome)
  }
  throw new SetupError(`Chrome did not start; see its log, or set CHROME_FLAGS`)
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "env-file": { type: "string" },
      record: { type: "boolean", default: false },
      out: { type: "string" },
      keep: { type: "boolean", default: false },
      "redis-image": { type: "string", default: "redis:7.2-alpine" },
    },
  })
  const envFile = values["env-file"] == null ? null : resolve(values["env-file"])
  const out = values.out == null ? join(APP_DIR, "shots/review-note.png") : resolve(values.out)
  const outProxy = out.replace(/(\.png)?$/, "-proxy.png")

  // Fail before starting anything when a piece is missing.
  if (envFile != null && !existsSync(envFile)) throw new SetupError(`--env-file ${envFile} does not exist`)
  if (envFile == null && !env.OPENAI_API_KEY) throw new SetupError("check:visual needs a key: pass --env-file <path> or set OPENAI_API_KEY")
  for (const [path, fix] of [
    [TSX_CLI, "run `pnpm install --frozen-lockfile` at the repository root"],
    [join(AGENT_MESH_DIR, "node_modules"), "run `pnpm install --frozen-lockfile` at the repository root"],
    [join(OVERLAY_DIR, "node_modules"), "run `pnpm install --frozen-lockfile` at the repository root"],
    [VITE_BIN, "run `pnpm --dir examples/ghent-live install --frozen-lockfile`"],
  ] as const) {
    if (!existsSync(path)) throw new SetupError(`${relative(REPO_DIR, path)} is missing: ${fix}`)
  }
  if (spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" }).status !== 0) {
    throw new SetupError("Docker is not available (the throwaway Redis runs in a container)")
  }

  const runId = randomBytes(3).toString("hex")
  // A short directory: the daemon's Unix socket lives under it.
  const work = mkdtempSync("/tmp/glr-")
  cleanups.push(() => {
    if (values.keep) say(`work directory kept: ${work}`)
    else rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  const meshHome = join(work, "m")
  mkdirSync(meshHome)
  if (!socketPathFits(meshHome)) throw new SetupError(`the mesh socket path under ${meshHome} is longer than 107 bytes`)

  const [redisPort, overlayPort, devPort] = [await freePort(), await freePort(), await freePort()]
  const appOrigin = `http://127.0.0.1:${devPort}`
  const proxyOrigin = `http://${PROXY_HOST}:${devPort}`

  say(`starting a throwaway Redis on 127.0.0.1:${redisPort}`)
  const redisName = `glr-redis-${runId}`
  cleanups.push(() => {
    spawnSync("docker", ["rm", "-f", redisName], { stdio: "ignore" })
    say(`removed the Redis container ${redisName}`)
  })
  const run = spawnSync("docker", ["run", "-d", "--name", redisName, "-p", `127.0.0.1:${redisPort}:6379`, values["redis-image"]], { encoding: "utf8" })
  if (run.status !== 0) throw new SetupError(`docker run failed: ${run.stderr.trim()}`)
  await waitUntil("Redis", 15_000, async () =>
    spawnSync("docker", ["exec", redisName, "redis-cli", "ping"], { encoding: "utf8" }).stdout.includes("PONG"),
  )

  const mesh: Mesh = { env: meshEnvironment(env, { redisUrl: `redis://127.0.0.1:${redisPort}`, home: meshHome, prefix: `glr${runId}` }) }
  await start("mesh daemon", process.execPath, [TSX_CLI, "src/daemon.ts"], { cwd: AGENT_MESH_DIR, env: mesh.env, log: join(work, "daemon.log") })
  const health = await waitUntil("the mesh daemon", 30_000, async () => {
    const answer = meshCli(mesh, "health")
    return answer.status === 0 ? (JSON.parse(answer.stdout) as { socket?: string; hostname?: string }) : null
  })
  // The CLI must be talking to this daemon and no other.
  if (health.socket !== join(meshHome, "daemon.sock") || health.hostname !== "review-e2e") {
    throw new SetupError("the mesh CLI answered from another daemon than the throwaway one")
  }
  const registered = meshCli(mesh, "register", "--id", REVIEWER_ID, "--role", "reviewer", "--deliver", "none", "--meta", `pid=${process.pid}`)
  if (registered.status !== 0) throw new SetupError(`registering ${REVIEWER_ID} failed: ${registered.stderr.trim()}`)
  say(`registered ${REVIEWER_ID} on the throwaway mesh`)

  const built = spawnSync(process.execPath, ["scripts/build-client.ts"], { cwd: OVERLAY_DIR, env: mesh.env, encoding: "utf8" })
  if (built.status !== 0) throw new SetupError(`building the overlay failed: ${built.stderr.trim()}`)
  const overlay = await start("overlay server", process.execPath, [
    "src/server/main.ts",
    "--port", String(overlayPort),
    "--origin", appOrigin,
    "--origin", proxyOrigin,
    "--target", REVIEWER_ID,
    "--reporter-id", REPORTER_ID,
    "--plan", join(APP_DIR, "plan/review-plan.json"),
    "--report-dir", join(work, "reports"),
    "--mesh-cli", JSON.stringify([process.execPath, TSX_CLI, MESH_CLI]),
  ], { cwd: OVERLAY_DIR, env: mesh.env, log: join(work, "overlay.log") })
  await waitUntil("the overlay server", 30_000, async () => (await fetch(`http://127.0.0.1:${overlayPort}/api/review`)).ok)

  const dev = await start("dev server", process.execPath, [VITE_BIN], {
    cwd: APP_DIR,
    env: appEnvironment(env, {
      GHENT_LIVE_PORT: String(devPort),
      GHENT_LIVE_OVERLAY: `http://127.0.0.1:${overlayPort}`,
      GHENT_LIVE_ALLOWED_HOSTS: PROXY_HOST,
    }),
    log: join(work, "dev.log"),
  })
  await waitUntil("the dev server", 60_000, async () => (await fetch(`${appOrigin}/`)).ok)
  // The dev server forwards the overlay on the app's own origin...
  const forwarded = (await (await fetch(`${appOrigin}/api/review`)).json()) as { enabled?: boolean; targetAgentId?: string }
  if (forwarded.enabled !== true || forwarded.targetAgentId !== REVIEWER_ID) throw new SetupError("the dev server does not forward /api/review to the overlay")
  // ...and accepts the proxy's Host only because GHENT_LIVE_ALLOWED_HOSTS names it.
  const [proxyStatus, strangerStatus] = [await statusForHost(devPort, PROXY_HOST), await statusForHost(devPort, "not-allowed.test")]
  if (proxyStatus !== 200 || strangerStatus !== 403) {
    throw new SetupError(`the dev server answers ${proxyStatus} for the proxy's host and ${strangerStatus} for another (expected 200 and 403)`)
  }

  const cdpUrl = await launchChrome({ work, extraFlags: (env.CHROME_FLAGS ?? "").split(/\s+/).filter((f) => f !== ""), proxyOrigin })

  const passes = [
    { label: "app origin", origin: appOrigin, out },
    { label: "through the proxy", origin: proxyOrigin, out: outProxy },
  ]
  const failures: string[] = []
  let firstShot: string | null = null
  for (const pass of passes) {
    const comment = `The red ring marks the Belfry (review e2e ${runId}, ${pass.label}).`
    const result = await reviewOnce({ cdpUrl, origin: pass.origin, label: pass.label, comment, mesh, out: pass.out, work })
    for (const problem of result.problems) failures.push(`${pass.label}: ${problem}`)
    if (result.problems.length === 0) say(`${pass.label}: the note carries the comment, the view's URL hash, and a screenshot with the ring and the pin`)
    if (result.screenshot != null) say(`${pass.label}: note screenshot: ${relative(process.cwd(), result.screenshot)}`)
    if (pass.out === out) firstShot = result.screenshot
  }

  let visualPassed = false
  if (firstShot != null) {
    say(`check:visual ${relative(APP_DIR, firstShot)} checks/review-note.json`)
    const check = spawnSync(
      process.execPath,
      ["scripts/check-visual.ts", firstShot, "checks/review-note.json", ...(envFile == null ? [] : ["--env-file", envFile]), ...(values.record ? ["--record"] : [])],
      { cwd: APP_DIR, encoding: "utf8" },
    )
    process.stdout.write(check.stdout)
    process.stderr.write(check.stderr)
    visualPassed = check.status === 0
    if (!visualPassed) failures.push(`check:visual did not pass (exit ${check.status})`)
  }

  if (failures.length > 0) {
    for (const failure of failures) say(`FAIL  ${failure}`)
    for (const started of [overlay, dev]) console.error(`--- ${started.name} log (last lines) ---\n${tail(started.log)}`)
    return 1
  }
  say("PASS: both notes reached the reviewer's inbox with the comment, the view and a screenshot, and check:visual passed")
  return 0
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stopAndExit = (code: number) => void cleanUp().finally(() => process.exit(code))
  process.once("SIGINT", () => stopAndExit(130))
  process.once("SIGTERM", () => stopAndExit(143))
  // A stuck step fails the run instead of leaving everything running.
  setTimeout(() => {
    console.error("[review-e2e] FAIL: the run took longer than 5 minutes")
    stopAndExit(1)
  }, 300_000).unref()
  main()
    .catch((error: unknown) => {
      console.error(`[review-e2e] ${error instanceof SetupError ? "could not run" : "FAIL"}: ${(error as Error).message}`)
      return error instanceof SetupError ? 2 : 1
    })
    .then(async (code) => {
      await cleanUp()
      process.exit(code)
    })
}
