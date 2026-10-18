import { fileURLToPath } from "node:url"
import { env } from "node:process"
import { defineConfig, type Plugin, type ProxyOptions } from "vite"
import { apiPlugin, loadRoutes } from "./server/api.ts"

// Each worker in a run starts its own dev server on its own port (NYC_LIVE_PORT).
// Both servers listen on loopback only. To reach one through a proxy that forwards
// its own Host header (for example `tailscale serve`), name that host in
// NYC_LIVE_ALLOWED_HOSTS, comma separated.
const port = Number(env.NYC_LIVE_PORT ?? 5180)
const allowedHosts = (env.NYC_LIVE_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter((h) => h !== "")

// The reviewer overlay (../../reviewer-overlay), for a person to pin review notes on
// the running app. Set NYC_LIVE_OVERLAY to its server (http://127.0.0.1:4848) and
// the dev server adds the overlay's script to the page and forwards the script and
// /api/review to it. The browser only ever talks to the app's own origin, so this
// also works through a proxy, while the overlay server stays on loopback.
const overlay = env.NYC_LIVE_OVERLAY
const overlayProxy: Record<string, ProxyOptions> | undefined =
  overlay == null || overlay === ""
    ? undefined
    : Object.fromEntries(
        ["/reviewer-overlay.js", "/reviewer-overlay.mjs", "/api/review"].map((path) => [
          path,
          { target: overlay, changeOrigin: true },
        ]),
      )

function reviewOverlayScript(): Plugin {
  return {
    name: "nyc-live-review-overlay",
    apply: "serve",
    transformIndexHtml: () => [{ tag: "script", attrs: { src: "/reviewer-overlay.js", defer: true }, injectTo: "body" }],
  }
}

export default defineConfig(async () => ({
  plugins: [
    apiPlugin(await loadRoutes(fileURLToPath(new URL("./server/routes", import.meta.url)))),
    ...(overlayProxy == null ? [] : [reviewOverlayScript()]),
  ],
  server: { host: "127.0.0.1", port, strictPort: true, allowedHosts, proxy: overlayProxy },
  preview: { host: "127.0.0.1", port: port + 1, strictPort: true, allowedHosts, proxy: overlayProxy },
  build: { target: "es2023", chunkSizeWarningLimit: 1500 },
}))
