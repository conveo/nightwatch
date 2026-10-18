import { fileURLToPath, URL } from "node:url"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

// The dashboard is served two ways:
//  - dev:   `pnpm --dir agent-mesh/dashboard dev` (vite on :5174), proxying /api
//           to the ui-server (which bridges to the daemon's unix socket).
//  - prod:  built to ./dist and served by agent-mesh/src/ui-server.ts.
// `base: "./"` keeps asset URLs relative so ui-server can serve them from "/".
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5174,
    proxy: {
      // changeOrigin stays off: ui-server refuses a POST whose Origin differs
      // from its Host, and rewriting Host to 127.0.0.1:4747 while the browser's
      // Origin stays localhost:5174 would make every dev-mode publish fail.
      "/api": { target: "http://127.0.0.1:4747", changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
})
