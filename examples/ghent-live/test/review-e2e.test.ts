import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import {
  appEnvironment,
  choosePinTip,
  CORRELATION_ID,
  decodePng,
  insideDir,
  isPng,
  meshEnvironment,
  noteProblems,
  parseInboxLine,
  pinHead,
  portAllowed,
  projectToScreen,
  REPORTER_ID,
  REVIEW_HASH,
  REVIEW_VIEW,
  ringPoints,
  sameView,
  screenshotProblems,
  socketPathFits,
  type Image,
  type InboxMessage,
  type NoteExpectation,
} from "../scripts/review-e2e.ts"
import { DEFAULT_VIEW, parseViewState } from "../src/view-state.ts"

// The end-to-end run needs Docker, Chrome and a key, so CI tests its pieces: the view
// and its hash, where the pin goes, what a delivered note must carry, the environment
// the throwaway mesh gets, and the real note screenshot committed with its recorded
// check:visual answers (test/fixtures/review-note.png, from `scripts/review-e2e.ts`).
const FIXTURE = resolve("test/fixtures/review-note.png")
// The viewport the fixture was taken in: Chrome's tab-sharing bar takes its height
// from the 1280x800 window.
const VIEWPORT = { w: 1280, h: 600, dpr: 1 }
const ORIGIN = "http://127.0.0.1:5999"

const fixture = () => decodePng(readFileSync(FIXTURE))
const copy = (image: Image): Image => ({ ...image, data: image.data.slice() })

function paintCircle(image: Image, centre: { x: number; y: number }, radius: number, rgb: [number, number, number]): void {
  for (let y = Math.floor(centre.y - radius); y <= centre.y + radius; y++) {
    for (let x = Math.floor(centre.x - radius); x <= centre.x + radius; x++) {
      if ((x - centre.x) ** 2 + (y - centre.y) ** 2 > radius * radius) continue
      const at = (y * image.width + x) * image.channels
      image.data.set(rgb, at)
    }
  }
}

test("the review view is the default view at night with the Belfry selected, and its hash round-trips", () => {
  assert.equal(REVIEW_HASH, "#cam=-250,420,620&tgt=0,0,0&sel=place:belfort&mode=fixture&light=night")
  assert.deepEqual(parseViewState(REVIEW_HASH), REVIEW_VIEW)
  assert.deepEqual({ ...REVIEW_VIEW, light: DEFAULT_VIEW.light, sel: DEFAULT_VIEW.sel }, DEFAULT_VIEW)
  const checks = JSON.parse(readFileSync("checks/review-note.json", "utf8")) as { view: string }
  assert.equal(checks.view, REVIEW_HASH)
})

test("sameView allows the hash's 0.1 m rounding and nothing else", () => {
  assert.ok(sameView({ ...REVIEW_VIEW, cam: [-250.04, 420, 620.05] }, REVIEW_VIEW))
  assert.ok(!sameView({ ...REVIEW_VIEW, cam: [-250.2, 420, 620] }, REVIEW_VIEW))
  assert.ok(!sameView({ ...REVIEW_VIEW, sel: "place:gravensteen" }, REVIEW_VIEW))
  assert.ok(!sameView({ ...REVIEW_VIEW, light: "day" }, REVIEW_VIEW))
  assert.ok(!sameView({ ...REVIEW_VIEW, layers: [] }, REVIEW_VIEW))
  assert.ok(!sameView({ ...REVIEW_VIEW, ask: "busy:now" }, REVIEW_VIEW))
})

test("the camera's target lands in the middle of the screen, the ring around it", () => {
  const centre = projectToScreen(REVIEW_VIEW, REVIEW_VIEW.tgt, VIEWPORT)!
  assert.ok(Math.abs(centre.x - VIEWPORT.w / 2) < 1e-6 && Math.abs(centre.y - VIEWPORT.h / 2) < 1e-6)
  // The camera is south-west of the Belfry: the ring's south side is nearer, so lower.
  const south = projectToScreen(REVIEW_VIEW, [0, 0.6, 30], VIEWPORT)!
  assert.ok(south.y > centre.y + 5, `south side at ${south.y}`)
  const points = ringPoints(REVIEW_VIEW, VIEWPORT)
  assert.equal(points.length, 24)
  for (const p of points) assert.ok(Math.hypot(p.x - centre.x, p.y - centre.y) < 80, `${p.x},${p.y}`)
  assert.equal(projectToScreen(REVIEW_VIEW, [-500, 420, 1000], VIEWPORT), null, "a point behind the camera")
})

test("the PNG reader decodes the committed note screenshot and refuses anything else", () => {
  const image = fixture()
  assert.deepEqual([image.width, image.height], [VIEWPORT.w, VIEWPORT.h])
  assert.ok(image.channels === 3 || image.channels === 4)
  assert.equal(image.data.length, image.width * image.height * image.channels)
  assert.ok(!isPng(Buffer.from("GIF89a, not a PNG at all, padded past 24 bytes")))
  assert.throws(() => decodePng(Buffer.from("not a PNG")), /not a PNG/)
})

test("the committed note screenshot shows the ring and the numbered pin on it", () => {
  const after = fixture()
  const { tip, red } = choosePinTip(after, REVIEW_VIEW, VIEWPORT)
  assert.ok(tip != null && red.length >= 12, `${red.length} red ring points`)
  // The same frame without the pin, as the page looked before it was dropped.
  const before = copy(after)
  paintCircle(before, pinHead(tip), 18, [3, 5, 11])
  assert.deepEqual(screenshotProblems({ before, after, viewport: VIEWPORT, tip, red }), [])
  // A frame with no new pin, and a black frame, both fail.
  assert.match(screenshotProblems({ before: after, after, viewport: VIEWPORT, tip, red }).join("\n"), /no pin above the tip/)
  const black = copy(after)
  black.data.fill(0)
  const problems = screenshotProblems({ before, after: black, viewport: VIEWPORT, tip, red }).join("\n")
  assert.match(problems, /does not show the red ring/)
  assert.match(problems, /no pin above the tip/)
})

function goodNote(): { message: InboxMessage; expected: NoteExpectation } {
  const tip = { x: 643.2, y: 314.6 }
  const comment = "The red ring marks the Belfry (review e2e 0a1b2c, app origin)."
  const message: InboxMessage = {
    id: "1795371416655-0",
    from: REPORTER_ID,
    type: "note",
    correlationId: CORRELATION_ID,
    body: {
      kind: "ui-review-comment",
      comment,
      url: `${ORIGIN}/${REVIEW_HASH}`,
      pin: { n: 1, xPct: 50.3, yPct: 52.4, pageX: 643, pageY: 315 },
      meta: { title: "ghent-live", viewport: VIEWPORT, userAgent: "test" },
      screenshot: FIXTURE,
      capturedAt: "2026-11-22T18:16:56.000Z",
    },
  }
  return { message, expected: { comment, origin: ORIGIN, view: REVIEW_VIEW, viewport: VIEWPORT, tip, reportDir: dirname(FIXTURE) } }
}

function withBody(message: InboxMessage, change: Record<string, unknown>): InboxMessage {
  return { ...message, body: { ...(message.body as object), ...change } }
}

test("a delivered note passes only when it carries what a review needs", () => {
  const { message, expected } = goodNote()
  assert.deepEqual(noteProblems(message, expected), [])

  const scratch = mkdtempSync(join(tmpdir(), "ghent-live-review-"))
  const notPng = join(scratch, "shot.png")
  writeFileSync(notPng, "not a PNG")
  const cases: Array<[InboxMessage, RegExp, Partial<NoteExpectation>?]> = [
    [{ ...message, type: "status" }, /a status, not a note/],
    [{ ...message, correlationId: "other" }, /correlation id/],
    [{ ...message, from: "someone-else" }, /comes from someone-else/],
    [withBody(message, { kind: "other" }), /kind/],
    [withBody(message, { comment: "another note" }), /the comment is "another note"/],
    [withBody(message, { url: "not a url" }), /is not a URL/],
    [withBody(message, { url: `http://127.0.0.1:6000/${REVIEW_HASH}` }), /is on http:\/\/127\.0\.0\.1:6000/],
    [withBody(message, { url: `${ORIGIN}/#cam=-250,420,620&tgt=0,0,0&mode=fixture` }), /not the view that was open/],
    [withBody(message, { pin: null }), /no numbered pin/],
    [withBody(message, { pin: { n: 1, xPct: 10, yPct: 52.4 } }), /not on the ring/],
    [withBody(message, { meta: { viewport: { w: 800, h: 600, dpr: 1 } } }), /viewport is 800x600/],
    [withBody(message, { screenshot: null }), /no screenshot/],
    [withBody(message, { screenshot: join(dirname(FIXTURE), "missing.png") }), /does not exist/],
    // Only a file the run's overlay saved is read.
    [withBody(message, { screenshot: notPng }), /not in the overlay's report directory/],
    [withBody(message, { screenshot: join(dirname(FIXTURE), "../review-e2e.test.ts") }), /not in the overlay's report directory/],
    [withBody(message, { screenshot: notPng }), /not a PNG/, { reportDir: scratch }],
  ]
  for (const [bad, problem, change] of cases) assert.match(noteProblems(bad, { ...expected, ...change }).join("\n"), problem)
  // A screenshot of another size than the viewport the note reports.
  assert.match(noteProblems(message, { ...expected, viewport: { w: 1280, h: 657, dpr: 1 } }).join("\n"), /not the 1280x657 viewport/)
})

test("an inbox line parses back into the message", () => {
  const body = { kind: "ui-review-comment", comment: "a: b [c]" }
  assert.deepEqual(parseInboxLine(`1795371416655-0  reviewer-overlay -> note [ui-review]: ${JSON.stringify(body)}`), {
    id: "1795371416655-0",
    from: "reviewer-overlay",
    type: "note",
    correlationId: "ui-review",
    body,
  })
  assert.equal(parseInboxLine("1-0  someone -> status: {}")?.correlationId, null)
  assert.equal(parseInboxLine("(no new messages)"), null)
  assert.equal(parseInboxLine("1-0  someone -> note [x]: {not json"), null)
})

test("mesh processes get a minimal environment that cannot reach another mesh", () => {
  const caller = {
    PATH: "/usr/bin",
    HOME: "/srv/someone",
    AGENT_MESH_HOME: "/srv/someone/.agent-mesh",
    AGENT_MESH_ID: "worker-1",
    AGENT_MESH_SOCK: "/srv/someone/.agent-mesh/daemon.sock",
    AGENT_MESH_REDIS_URL: "redis://127.0.0.1:6379",
    HERDR_PANE_ID: "w1:p1",
    CLAUDE_CODE_SESSION_ID: "abc",
    OPENAI_API_KEY: "not-a-real-key",
  }
  const mesh = meshEnvironment(caller, { redisUrl: "redis://127.0.0.1:41000", home: "/tmp/glr-abc123/m", prefix: "glrabc" })
  assert.deepEqual(mesh, {
    AGENT_MESH_REDIS_URL: "redis://127.0.0.1:41000",
    AGENT_MESH_HOME: "/tmp/glr-abc123/m",
    AGENT_MESH_PREFIX: "glrabc",
    AGENT_MESH_HOSTNAME: "review-e2e",
    PATH: "/usr/bin",
    HOME: "/srv/someone",
  })
  const app = appEnvironment(caller, { GHENT_LIVE_PORT: "41001" })
  assert.deepEqual(app, { PATH: "/usr/bin", HOME: "/srv/someone", GHENT_LIVE_PORT: "41001" })
})

test("insideDir accepts files under the directory and nothing else", () => {
  assert.ok(insideDir("/tmp/glr-abc123/reports/a.png", "/tmp/glr-abc123/reports"))
  assert.ok(!insideDir("/tmp/glr-abc123/reports", "/tmp/glr-abc123/reports"))
  assert.ok(!insideDir("/tmp/glr-abc123/reports/../m/daemon.sock", "/tmp/glr-abc123/reports"))
  assert.ok(!insideDir("/tmp/glr-abc123/reports-other/a.png", "/tmp/glr-abc123/reports"))
})

test("the mesh home fits a Unix socket path, and the run's ports are never picked", () => {
  assert.ok(socketPathFits("/tmp/glr-abc123/m"))
  assert.ok(!socketPathFits(`/tmp/${"x".repeat(100)}`))
  for (const port of [4858, 5280, 5281, 5290, 9343, 5302, 5310, 5320]) assert.ok(!portAllowed(port), String(port))
  for (const port of [5301, 5321, 41000]) assert.ok(portAllowed(port), String(port))
})

// The note screenshot's real answers, replayed: no key, no network.
test("the recorded note screenshot passes its visual checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(process.execPath, ["scripts/check-visual.ts", FIXTURE, "checks/review-note.json", "--replay"], { encoding: "utf8", env })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 2, run.stdout)
})
