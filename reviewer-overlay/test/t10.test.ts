import assert from "node:assert/strict"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { after, before, describe, it } from "node:test"
import { build } from "esbuild"
import { PIN_RADIUS, pinPath } from "../src/client/annotate.ts"
import { meshMarkSvg } from "../src/client/mark.ts"

// test/fixtures/t10-*.png are real screenshots of the overlay over nyc-live, and
// test/recordings/ holds the Decisions API's real answers comparing them with the
// design reference, so this runs the whole check with no key and no reference.
function designCheck(...args: string[]) {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  return spawnSync(process.execPath, ["test/design-check.ts", ...args], { encoding: "utf8", env })
}

describe("T10 design check", () => {
  it("the recorded screenshots match the design reference", () => {
    const run = designCheck("test/checks/t10.json", "--replay")
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout.match(/^PASS /gm)?.length, 2, run.stdout)
  })

  it("a missing recording is an error, not a pass", () => {
    const empty = mkdtempSync(join(tmpdir(), "reviewer-overlay-no-recordings-"))
    const run = designCheck("test/checks/t10.json", "--replay", "--recordings", empty)
    assert.equal(run.status, 2)
    assert.match(run.stderr, /no recorded answer/)
  })

  it("a changed screenshot does not replay the old answers", () => {
    const spec = JSON.parse(readFileSync("test/checks/t10.json", "utf8")) as { shots: Array<{ path: string }> }
    const swapped = { ...spec, shots: spec.shots.map((shot, index) => ({ ...shot, path: spec.shots[1 - index]?.path ?? shot.path })) }
    const path = join(mkdtempSync(join(tmpdir(), "reviewer-overlay-swapped-")), "t10.json")
    writeFileSync(path, JSON.stringify(swapped))
    const run = designCheck(path, "--replay")
    assert.equal(run.status, 2, run.stdout)
  })

  it("fails when the look changed since the answers were recorded", () => {
    // Fewer look files give another fingerprint, as an edit to one of them would.
    const spec = JSON.parse(readFileSync("test/checks/t10.json", "utf8")) as { look: { files: string[] } }
    const stale = { ...spec, look: { files: spec.look.files.slice(1) } }
    const path = join(mkdtempSync(join(tmpdir(), "reviewer-overlay-stale-")), "t10.json")
    writeFileSync(path, JSON.stringify(stale))
    const run = designCheck(path, "--replay")
    assert.equal(run.status, 1, run.stderr)
    assert.match(run.stdout, /^FAIL {2}look_is_current/m)
  })
})

describe("T10 look", () => {
  it("inlines the agent-mesh mark unchanged", () => {
    const normalise = (markup: string) =>
      markup
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\b([mc])-test\b/g, "$1")
        .replace(/\s+/g, " ")
        .replace(/> </g, "><")
        .trim()
    const file = readFileSync("../agent-mesh/dashboard/public/agentmesh-mark.svg", "utf8")
    assert.equal(normalise(meshMarkSvg("test")), normalise(file))
  })

  it("puts the pin's tip on the point the reviewer clicked", () => {
    const { d, cx, cy } = pinPath({ x: 100, y: 200, r: PIN_RADIUS })
    assert.match(d, /^M 100 200 L /)
    assert.equal(cx, 100)
    assert.ok(cy < 200 - PIN_RADIUS, "the head sits above the tip")
  })

  // e2e/run.sh and the nyc-live review script drive the overlay by these classes
  // and visible texts, so a restyle must keep every one of them.
  it("keeps the selectors and labels the e2e script uses", () => {
    const script = readFileSync("e2e/run.sh", "utf8")
    const source = readFileSync("src/client/overlay.ts", "utf8")
    const selectors = [
      ...script.matchAll(/shadow_center "([^"]+)"/g),
      ...script.matchAll(/shadowRoot\??\.querySelector\('([^']+)'\)/g),
    ].map((match) => match[1] ?? "")
    const classes = new Set(selectors.flatMap((selector) => [...selector.matchAll(/\.([a-z][a-z-]*)/g)].map((match) => match[1] ?? "")))
    assert.ok(classes.has("bubble") && classes.has("composer"), [...classes].join(" "))
    for (const name of classes) {
      assert.match(source, new RegExp(`["\`](?:[a-z-]+ )*${name}["\` $]`), `class ${name}`)
    }
    for (const label of ["Click the page to drop a pin", "steps checked", "Pin #${", "Sent to ${", "Add comment", "Open reviewer"]) {
      assert.ok(source.includes(label), label)
    }
  })
})

// ---- in a real browser ----
//
// The overlay is bundled from source and started on a blank page in headless
// Chrome, driven over the DevTools protocol with real mouse input. Set
// REVIEWER_OVERLAY_CDP to a running Chrome's DevTools URL to use it instead of
// starting one; without either, these tests are skipped.

const CHROME_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

type Browser = { wsUrl: string; close: () => Promise<void> }

async function openBrowser(): Promise<Browser | null> {
  const shared = process.env.REVIEWER_OVERLAY_CDP
  if (shared != null && shared !== "") {
    const version = (await (await fetch(`${shared}/json/version`)).json()) as { webSocketDebuggerUrl: string }
    return { wsUrl: version.webSocketDebuggerUrl, close: async () => {} }
  }
  const binary = [process.env.CHROME, ...CHROME_PATHS].find((path) => path != null && existsSync(path))
  if (binary == null) {
    return null
  }
  const profile = mkdtempSync(join(tmpdir(), "reviewer-overlay-chrome-"))
  // --no-sandbox: CI containers often cannot start Chrome's sandbox, and the
  // page only ever loads this test's own script.
  const chrome: ChildProcess = spawn(
    binary,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--no-sandbox", "about:blank"],
    { stdio: "ignore" },
  )
  // Chrome keeps writing to its profile while it exits, so wait for the exit
  // (briefly) before removing the profile, and never fail the run on cleanup.
  const close = async () => {
    if (chrome.exitCode == null && chrome.signalCode == null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve))
      chrome.kill()
      await Promise.race([exited, sleep(5000)])
    }
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A leftover temporary profile is harmless.
    }
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const portFile = join(profile, "DevToolsActivePort")
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").split("\n")
      if (port != null && path != null && path !== "") {
        return { wsUrl: `ws://127.0.0.1:${port}${path}`, close }
      }
    }
    await sleep(100)
  }
  await close()
  throw new Error(`Chrome did not start (${binary})`)
}

// Just enough of the DevTools protocol: one page target with a flat session.
class Page {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private sessionId = ""
  private targetId = ""
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      const waiter = message.id == null ? undefined : this.pending.get(message.id)
      if (waiter == null || message.id == null) {
        return
      }
      this.pending.delete(message.id)
      if (message.error != null) {
        waiter.reject(new Error(message.error.message))
      } else {
        waiter.resolve(message.result)
      }
    })
  }

  static async open(wsUrl: string, viewport: { width: number; height: number }): Promise<Page> {
    const socket = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true })
      socket.addEventListener("error", () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true })
    })
    const page = new Page(socket)
    page.targetId = (await page.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }, false)).targetId
    page.sessionId = (await page.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true }, false)).sessionId
    await page.resize(viewport)
    return page
  }

  send<T>(method: string, params: object = {}, inSession = true): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(inSession ? { sessionId: this.sessionId } : {}) }))
    })
  }

  resize(viewport: { width: number; height: number }): Promise<unknown> {
    return this.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false })
  }

  async eval<T>(expression: string): Promise<T> {
    const reply = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (reply.exceptionDetails != null) {
      throw new Error(`page error: ${reply.exceptionDetails.text}`)
    }
    return reply.result.value
  }

  async click(point: { x: number; y: number }): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
  }

  async close(): Promise<void> {
    await this.send("Target.closeTarget", { targetId: this.targetId }, false).catch(() => {})
    this.socket.close()
  }
}

const SHADOW = "document.querySelector('reviewer-overlay').shadowRoot"
const shown = (selector: string) =>
  `(() => { const el = ${SHADOW}.querySelector(${JSON.stringify(selector)}); return el != null && el.getClientRects().length > 0 })()`
const rectOf = (page: Page, selector: string) =>
  page.eval<{ x: number; y: number; left: number; right: number; width: number }>(
    `(() => { const r = ${SHADOW}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, width: r.width } })()`,
  )
const overlayText = (page: Page) => page.eval<string>(`${SHADOW}.querySelector('.root').innerText`)

describe("T10 overlay in a browser", () => {
  let browser: Browser | null = null
  let bundle = ""

  before(async () => {
    browser = await openBrowser()
    const built = await build({ entryPoints: ["src/client/index.ts"], bundle: true, write: false, format: "iife", globalName: "ReviewerOverlayTest", target: ["chrome110"] })
    bundle = built.outputFiles[0]?.text ?? ""
  })
  after(async () => {
    await browser?.close()
  })

  // A blank page with the overlay open. Nothing listens on port 9, so the plan
  // fails to load quickly; comments still work without it.
  async function overlayPage(viewport: { width: number; height: number }): Promise<Page> {
    const page = await Page.open(browser!.wsUrl, viewport)
    await page.eval(`document.body.style.cssText = "margin:0;height:100vh;background:#0b1020"; ${bundle}; ReviewerOverlayTest.init({ server: "http://127.0.0.1:9", capture: "none", startOpen: true }); true`)
    return page
  }

  it("on a phone-sized screen, the panel steps aside while the reviewer pins", async (t) => {
    if (browser == null) {
      t.skip("no Chrome found (set CHROME or REVIEWER_OVERLAY_CDP)")
      return
    }
    const page = await overlayPage({ width: 360, height: 740 })
    try {
      const panel = await rectOf(page, ".panel")
      assert.equal(Math.round(panel.width), 360, "the open panel fills a 360px screen")

      await page.click(await rectOf(page, ".panel-foot .btn.primary"))
      assert.ok((await overlayText(page)).includes("Click the page to drop a pin"), "comment mode is on")
      assert.equal(await page.eval(shown(".panel")), false, "the panel no longer covers the page")
      assert.equal(await page.eval(shown(".toolbar")), true, "the comment tools stay visible")

      await page.click({ x: 180, y: 420 })
      assert.ok((await overlayText(page)).includes("Pin #1"), "a click on the page drops pin 1")
      const composer = await rectOf(page, ".composer")
      assert.ok(composer.left >= 0 && composer.right <= 360, `the composer fits the screen (${composer.left}..${composer.right})`)

      await page.click(await rectOf(page, ".toolbar .btn:nth-last-of-type(1)"))
      assert.equal(await page.eval(shown(".toolbar")), false, "Done leaves comment mode")
      assert.equal(await page.eval(shown(".panel")), true, "and the panel comes back")
    } finally {
      await page.close()
    }
  })

  it("on a wide screen, the panel stays open beside the page in comment mode", async (t) => {
    if (browser == null) {
      t.skip("no Chrome found (set CHROME or REVIEWER_OVERLAY_CDP)")
      return
    }
    const page = await overlayPage({ width: 1280, height: 800 })
    try {
      await page.click(await rectOf(page, ".panel-foot .btn.primary"))
      assert.equal(await page.eval(shown(".panel")), true)
      await page.click({ x: 640, y: 400 })
      const [composer, panel] = [await rectOf(page, ".composer"), await rectOf(page, ".panel")]
      assert.ok(composer.right <= panel.left, `the composer opens beside the panel (${composer.right} <= ${panel.left})`)
    } finally {
      await page.close()
    }
  })
})
