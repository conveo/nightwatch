import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
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
