import { fileURLToPath } from "node:url"
import { env } from "node:process"
import { defineConfig } from "vite"
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

export default defineConfig(async () => ({
  plugins: [apiPlugin(await loadRoutes(fileURLToPath(new URL("./server/routes", import.meta.url))))],
  server: { host: "127.0.0.1", port, strictPort: true, allowedHosts },
  preview: { host: "127.0.0.1", port: port + 1, strictPort: true, allowedHosts },
  build: { target: "es2023", chunkSizeWarningLimit: 1500 },
}))
