import { build } from "esbuild"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")
const shared = {
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ["chrome110", "firefox115", "safari16"],
  legalComments: "none" as const,
  logLevel: "warning" as const,
}

await build({
  ...shared,
  entryPoints: [join(root, "src/client/index.ts")],
  format: "esm",
  outfile: join(root, "dist/reviewer-overlay.js"),
})
await build({
  ...shared,
  entryPoints: [join(root, "src/client/auto.ts")],
  format: "iife",
  outfile: join(root, "dist/reviewer-overlay.iife.js"),
})
process.stdout.write("built dist/reviewer-overlay.js and dist/reviewer-overlay.iife.js\n")
