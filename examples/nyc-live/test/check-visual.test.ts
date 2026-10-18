import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

// test/fixtures/venue.png is a real screenshot of the base app, and
// test/recordings/ holds the Decisions API's real answers for it, so this runs
// the whole command with no key and no network.
function checkVisual(...args: string[]) {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  return spawnSync(process.execPath, ["scripts/check-visual.ts", ...args], { encoding: "utf8", env })
}

test("the recorded venue screenshot passes its checks", () => {
  const run = checkVisual("test/fixtures/venue.png", "checks/venue.json", "--replay")
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 3, run.stdout)
})

test("a missing recording is an error, not a pass", () => {
  const empty = mkdtempSync(join(tmpdir(), "nyc-live-no-recordings-"))
  const run = checkVisual("test/fixtures/venue.png", "checks/venue.json", "--replay", "--recordings", empty)
  assert.equal(run.status, 2)
  assert.match(run.stderr, /no recorded answer/)
})
