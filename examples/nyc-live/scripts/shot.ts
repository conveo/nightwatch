// Screenshot the running app once it reports ready.
//
//   pnpm shot                                   # the default view of the dev server
//   pnpm shot --hash '#cam=0,900,1&tgt=0,0,0'   # any view: the hash is the view state
//   pnpm shot --out shots/venue.png --width 1600 --height 900
//
// Uses the shared browser in NYC_LIVE_CDP when set (see `pnpm browser`), else a
// private Chrome. Prints the file path and the app's layer report.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import process, { env } from "node:process"
import { parseArgs } from "node:util"
import { launchChrome, screenshot } from "./chrome.ts"

const { values } = parseArgs({
  options: {
    url: { type: "string", default: `http://127.0.0.1:${env.NYC_LIVE_PORT ?? 5180}/` },
    hash: { type: "string", default: "" },
    out: { type: "string" },
    width: { type: "string", default: "1600" },
    height: { type: "string", default: "900" },
    timeout: { type: "string", default: "60000" },
  },
})

const url = values.url + values.hash
const out = values.out ?? `shots/shot-${new Date().toISOString().replaceAll(":", "-")}.png`
const shared = env.NYC_LIVE_CDP
const chrome = shared == null ? await launchChrome() : null

try {
  const { png, app } = await screenshot(shared ?? chrome!.cdpUrl, url, {
    width: Number(values.width),
    height: Number(values.height),
    timeoutMs: Number(values.timeout),
  })
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, png)
  console.log(out)
  console.log(`layers: ${app?.layers.join(", ")}`)
  if (app != null && app.errors.length > 0) console.log(`layer errors:\n  ${app.errors.join("\n  ")}`)
} catch (error) {
  console.error(`shot failed: ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  await chrome?.close()
}
