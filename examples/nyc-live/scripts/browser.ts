// Start one shared headless Chrome for every worker on this box and keep it running.
//
//   pnpm browser                 # prints: export NYC_LIVE_CDP=http://127.0.0.1:9333
//
// Workers set NYC_LIVE_CDP so `pnpm shot` opens a tab here instead of launching a
// Chrome of its own. Stop it with Ctrl-C.

import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { env, exit } from "node:process"
import { devtoolsAnswering, launchChrome } from "./chrome.ts"

const port = Number(env.NYC_LIVE_CDP_PORT ?? 9333)
const running = await devtoolsAnswering(port)
if (running != null) {
  console.log(`a shared Chrome is already running\nexport NYC_LIVE_CDP=${running}`)
  exit(0)
}
const profileDir = join(tmpdir(), "nyc-live-shared-chrome")
mkdirSync(profileDir, { recursive: true })

const chrome = await launchChrome({ port, profileDir })
console.log(`shared Chrome ready\nexport NYC_LIVE_CDP=${chrome.cdpUrl}`)

const stop = async () => {
  await chrome.close()
  exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
chrome.process.on("exit", (code) => {
  console.error(`Chrome exited (${code ?? "signal"})`)
  exit(1)
})
