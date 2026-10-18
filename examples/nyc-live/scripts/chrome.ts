// Headless Chrome for screenshots, driven over the DevTools protocol with Node's
// built-in WebSocket. No browser automation dependency to install.
//
// In a run, start ONE shared browser per box (`pnpm browser`) and point every
// worker at it with NYC_LIVE_CDP: one Chrome per worker is how a fleet runs out of
// memory. Without NYC_LIVE_CDP, a screenshot launches a private Chrome and closes it.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { env } from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

export function findChrome(): string | null {
  if (env.CHROME != null && existsSync(env.CHROME)) return env.CHROME
  const home = homedir()
  const candidates: string[] = []
  const agentBrowser = join(home, ".agent-browser/browsers")
  if (existsSync(agentBrowser)) {
    for (const dir of readdirSync(agentBrowser).filter((d) => d.startsWith("chrome-")).sort().reverse()) {
      candidates.push(join(agentBrowser, dir, "chrome"))
    }
  }
  const playwright = join(home, ".cache/ms-playwright")
  if (existsSync(playwright)) {
    for (const dir of readdirSync(playwright).sort().reverse()) {
      candidates.push(
        join(playwright, dir, "chrome-linux64/chrome"),
        join(playwright, dir, "chrome-headless-shell-linux64/chrome-headless-shell"),
      )
    }
  }
  candidates.push(
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  )
  return candidates.find((c) => existsSync(c)) ?? null
}

export type LaunchedChrome = { cdpUrl: string; process: ChildProcess; close(): Promise<void> }

// Chrome keeps writing to its profile while it shuts down, so wait for the exit
// (briefly) before deleting a throwaway profile.
async function stopChrome(child: ChildProcess, profile: string | null): Promise<void> {
  if (child.exitCode == null && child.signalCode == null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill()
    await Promise.race([exited, sleep(5000)])
  }
  if (profile != null) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

// Some containers cannot use Chrome's sandbox. Launch with it first, and only when
// Chrome exits during startup retry with --no-sandbox, saying so.
export async function launchChrome(options: { port?: number; profileDir?: string } = {}): Promise<LaunchedChrome> {
  const binary = findChrome()
  if (binary == null) throw new Error("no Chrome found; set CHROME to a Chrome or Chromium binary")
  for (const noSandbox of [false, true]) {
    const profile = options.profileDir ?? mkdtempSync(join(tmpdir(), "nyc-live-chrome-"))
    rmSync(join(profile, "DevToolsActivePort"), { force: true })
    const args = [
      "--headless=new",
      `--remote-debugging-port=${options.port ?? 0}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      ...(noSandbox ? ["--no-sandbox"] : []),
    ]
    const child = spawn(binary, args, { stdio: "ignore" })
    let exited = false
    child.once("exit", () => {
      exited = true
    })
    for (let i = 0; i < 100 && !exited; i++) {
      const portFile = join(profile, "DevToolsActivePort")
      if (existsSync(portFile)) {
        const port = readFileSync(portFile, "utf8").split("\n")[0]
        if (port != null && port !== "") {
          if (noSandbox) console.error("chrome: started with --no-sandbox (the sandbox is not available here)")
          const close = () => stopChrome(child, options.profileDir == null ? profile : null)
          return { cdpUrl: `http://127.0.0.1:${port}`, process: child, close }
        }
      }
      await sleep(150)
    }
    await stopChrome(child, options.profileDir == null ? profile : null)
  }
  throw new Error(`Chrome did not start (${binary})`)
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

// Just enough of the DevTools protocol: one browser connection, flattened sessions.
class Cdp {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (message.id == null) return
      const waiter = this.pending.get(message.id)
      if (waiter == null) return
      this.pending.delete(message.id)
      if (message.error != null) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
  }

  static async connect(cdpUrl: string): Promise<Cdp> {
    const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string }
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error(`cannot connect to ${cdpUrl}`)), { once: true })
    })
    return new Cdp(socket)
  }

  send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId != null ? { sessionId } : {}) }))
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }))
  }

  close(): void {
    this.socket.close()
  }
}

export type AppState = { ready: boolean; layers: string[]; errors: string[] } | null

// Opens `url` in a new tab, waits until the app sets window.__nycLive.ready, takes a
// PNG of the viewport and closes the tab.
export async function screenshot(
  cdpUrl: string,
  url: string,
  options: { width: number; height: number; timeoutMs: number },
): Promise<{ png: Buffer; app: AppState }> {
  const cdp = await Cdp.connect(cdpUrl)
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId)
    await cdp.send("Page.enable", {}, sessionId)
    await cdp.send("Page.navigate", { url }, sessionId)
    const deadline = Date.now() + options.timeoutMs
    let app: AppState = null
    while (Date.now() < deadline) {
      const { result } = await cdp.send<{ result: { value?: string } }>(
        "Runtime.evaluate",
        { expression: "JSON.stringify(window.__nycLive ?? null)", returnByValue: true },
        sessionId,
      )
      app = JSON.parse(result.value ?? "null") as AppState
      if (app?.ready === true) break
      await sleep(250)
    }
    if (app?.ready !== true) throw new Error(`the app did not report ready within ${options.timeoutMs} ms at ${url}`)
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId)
    return { png: Buffer.from(data, "base64"), app }
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {})
    cdp.close()
  }
}
