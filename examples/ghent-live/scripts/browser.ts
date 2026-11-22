// Start one shared headless Chrome for every worker on this box and keep it running.
//
//   pnpm browser                 # prints: export GHENT_LIVE_CDP=http://127.0.0.1:9343
//
// Workers set GHENT_LIVE_CDP so `pnpm shot` opens a tab here instead of launching a
// Chrome of its own. Stop it with Ctrl-C.

import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { env, exit } from "node:process"
import { devtoolsAnswering, launchChrome } from "./chrome.ts"

const port = Number(env.GHENT_LIVE_CDP_PORT ?? 9343)
const running = await devtoolsAnswering(port)
if (running != null) {
  console.log(`a shared Chrome is already running\nexport GHENT_LIVE_CDP=${running}`)
  exit(0)
}
const profileDir = join(tmpdir(), "ghent-live-shared-chrome")
mkdirSync(profileDir, { recursive: true })

const chrome = await launchChrome({ port, profileDir })
console.log(`shared Chrome ready\nexport GHENT_LIVE_CDP=${chrome.cdpUrl}`)

// Closing Chrome on purpose also fires its "exit" event; only an exit nobody asked
// for is a failure.
let stopping = false
const stop = async () => {
  stopping = true
  await chrome.close()
  exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
chrome.process.on("exit", (code) => {
  if (stopping) return
  console.error(`Chrome exited (${code ?? "signal"})`)
  exit(1)
})
