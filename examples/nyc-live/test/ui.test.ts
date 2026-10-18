import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
import { test } from "node:test"
import { VENUE, toLatLon } from "../src/geo.ts"
import {
  activePreset,
  easeInOutCubic,
  flightMs,
  interpolatePose,
  MAX_FLIGHT_MS,
  MIN_FLIGHT_MS,
  offset,
  poseToView,
  PRESETS,
  turn,
  viewToPose,
  type Pose,
  type PresetId,
} from "../src/ui/camera.ts"
import { PLACES, placeLabels } from "../src/ui/labels.ts"
import { isLayerShown, layerName, toggleLayer } from "../src/ui/layers.ts"
import { DEFAULT_VIEW, parseViewState, serializeViewState } from "../src/view-state.ts"

function preset(id: PresetId) {
  const p = PRESETS.find((p) => p.id === id)
  assert.ok(p, `no preset ${id}`)
  return p
}

function close(actual: number, expected: number, tolerance: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`)
}

// main.ts sets MapControls' maxPolarAngle to PI / 2.05: a camera flatter than this
// would be pulled up by the controls on the first frame and stop matching its preset.
const MIN_PITCH_DEG = 90 - 180 / 2.05

test("there are five presets, in toolbar order", () => {
  assert.deepEqual(
    PRESETS.map((p) => p.label),
    ["Venue", "Battery", "Brooklyn Bridge", "From above", "Street level"],
  )
})

test("the app opens on the Venue preset", () => {
  assert.deepEqual(preset("venue").view, { cam: DEFAULT_VIEW.cam, tgt: DEFAULT_VIEW.tgt })
  assert.equal(activePreset(parseViewState(""))?.id, "venue")
})

test("every preset survives a round trip through the URL and is recognised", () => {
  for (const p of PRESETS) {
    const hash = serializeViewState({ ...DEFAULT_VIEW, ...p.view })
    const back = parseViewState(hash)
    assert.deepEqual({ cam: back.cam, tgt: back.tgt }, p.view, p.id)
    assert.equal(activePreset(back)?.id, p.id, hash)
  }
})

test("a view away from every preset is no preset", () => {
  assert.equal(activePreset({ cam: [100, 900, 100], tgt: [0, 0, 0] }), null)
  // Within a metre still counts: the URL rounds to 0.1 m and damping settles late.
  assert.equal(activePreset({ cam: [320.6, 419.5, 620.9], tgt: [0, 0, 0.4] })?.id, "venue")
})

test("every preset is steep enough that MapControls leaves it alone", () => {
  for (const p of PRESETS) {
    const pose = viewToPose(p.view)
    assert.ok(pose.pitch > MIN_PITCH_DEG, `${p.id} pitch ${pose.pitch}`)
    assert.ok(pose.distance > 1, `${p.id} distance ${pose.distance}`)
  }
})

test("a pose turns into a camera view and back", () => {
  const pose: Pose = { target: [12, 5, -40], distance: 900, pitch: 35, heading: 29 }
  const back = viewToPose(poseToView(pose))
  assert.deepEqual(back.target, pose.target)
  close(back.distance, pose.distance, 1e-9, "distance")
  close(back.pitch, pose.pitch, 1e-9, "pitch")
  close(back.heading, pose.heading, 1e-9, "heading")
})

test("a heading is the compass direction the camera faces", () => {
  // Facing north (-z), the camera stands south of its target (+z).
  const north = poseToView({ target: [0, 0, 0], distance: 100, pitch: 0, heading: 0 })
  close(north.cam[0], 0, 1e-9, "x")
  close(north.cam[2], 100, 1e-9, "z")
  // Facing east (+x), it stands west of it (-x).
  const east = poseToView({ target: [0, 0, 0], distance: 100, pitch: 0, heading: 90 })
  close(east.cam[0], -100, 1e-9, "x")
  close(east.cam[2], 0, 1e-9, "z")
  // Looking straight down, it stands right above it.
  const down = poseToView({ target: [0, 0, 0], distance: 100, pitch: 90, heading: 0 })
  close(down.cam[1], 100, 1e-9, "y")
  // The venue preset faces north-north-west, toward Greenwich Village.
  close(viewToPose(preset("venue").view).heading, 332.7, 0.1, "venue heading")
})

test("the Battery preset looks at the Battery, up the island", () => {
  const pose = viewToPose(preset("battery").view)
  const where = toLatLon({ x: pose.target[0], z: pose.target[2] })
  close(where.lat, 40.7036, 0.0005, "lat")
  close(where.lon, -74.0164, 0.0005, "lon")
  close(pose.heading, 29, 0.5, "heading along the avenues")
  // The camera is over the harbour: south of the Battery.
  assert.ok(preset("battery").view.cam[2] > pose.target[2])
})

test("the Brooklyn Bridge preset looks at the middle of the bridge, side on", () => {
  const pose = viewToPose(preset("brooklyn-bridge").view)
  const where = toLatLon({ x: pose.target[0], z: pose.target[2] })
  close(where.lat, 40.7057, 0.0005, "lat")
  close(where.lon, -73.9958, 0.0005, "lon")
  // The bridge runs at about 126 degrees; side on is a quarter turn from that.
  close(Math.abs(turn(pose.heading, 126)), 90, 5, "angle to the bridge")
})

test("From above looks almost straight down on the island, from the Battery to Union Square", () => {
  const pose = viewToPose(preset("above").view)
  assert.ok(pose.pitch > 85, `pitch ${pose.pitch}`)
  // The avenues run across the screen, uptown on the right.
  close(pose.heading, 299, 1, "heading")
  // main.ts uses a 45 degree vertical field of view; screenshots are 16:9.
  const halfHeight = pose.distance * Math.tan((22.5 * Math.PI) / 180)
  const halfWidth = (halfHeight * 16) / 9
  const up = pose.heading * (Math.PI / 180)
  const right = up + Math.PI / 2
  for (const id of ["battery-park", "union-square", "venue"]) {
    const place = PLACES.find((p) => p.id === id)!
    const dx = place.at[0] - pose.target[0]
    const dz = place.at[2] - pose.target[2]
    // Screen axes on the ground: east is +x, north is -z.
    const across = dx * Math.sin(right) - dz * Math.cos(right)
    const along = dx * Math.sin(up) - dz * Math.cos(up)
    assert.ok(Math.abs(across) < halfWidth * 0.9, `${id} is ${Math.round(across)} m across, screen half-width ${Math.round(halfWidth)}`)
    assert.ok(Math.abs(along) < halfHeight * 0.9, `${id} is ${Math.round(along)} m up, screen half-height ${Math.round(halfHeight)}`)
  }
})

test("Street level stands at eye height on Broadway and faces the venue", () => {
  const p = preset("street")
  assert.ok(p.view.cam[1] < 12, `camera height ${p.view.cam[1]}`)
  const pose = viewToPose(p.view)
  // Facing roughly north-north-east, and the venue is ahead within 10 degrees.
  const bearingToVenue = (Math.atan2(-p.view.cam[0], p.view.cam[2]) * 180) / Math.PI
  close(Math.abs(turn(pose.heading, bearingToVenue)), 0, 10, "venue ahead")
  close(Math.hypot(p.view.cam[0], p.view.cam[2]), 300, 10, "distance to the venue")
})

test("offset moves forward along a heading and right across it", () => {
  const ahead = offset([0, 7, 0], 90, 10, 0)
  close(ahead[0], 10, 1e-9, "east")
  close(ahead[2], 0, 1e-9, "z")
  assert.equal(ahead[1], 7)
  const right = offset([0, 0, 0], 0, 0, 10)
  close(right[0], 10, 1e-9, "facing north, right is east")
  close(right[2], 0, 1e-9, "z")
})

test("turns go the short way round", () => {
  assert.equal(turn(350, 10), 20)
  assert.equal(turn(10, 350), -20)
  assert.equal(turn(0, 180), -180)
  assert.equal(turn(90, 90), 0)
})

test("the easing starts and ends still and never goes backwards", () => {
  assert.equal(easeInOutCubic(0), 0)
  assert.equal(easeInOutCubic(1), 1)
  assert.equal(easeInOutCubic(0.5), 0.5)
  let last = 0
  for (let i = 1; i <= 100; i++) {
    const e = easeInOutCubic(i / 100)
    assert.ok(e >= last, `step ${i}`)
    last = e
  }
  // Slow at both ends.
  assert.ok(easeInOutCubic(0.05) < 0.05)
  assert.ok(easeInOutCubic(0.95) > 0.95)
})

test("a flight starts at the current view and lands exactly on the preset", () => {
  for (const a of PRESETS) {
    for (const b of PRESETS) {
      const from = viewToPose(a.view)
      const to = viewToPose(b.view)
      const start = poseToView(interpolatePose(from, to, 0))
      const end = poseToView(interpolatePose(from, to, 1))
      for (let i = 0; i < 3; i++) {
        close(start.cam[i]!, a.view.cam[i]!, 1e-6, `${a.id} to ${b.id} start`)
        close(end.cam[i]!, b.view.cam[i]!, 1e-6, `${a.id} to ${b.id} end`)
        close(end.tgt[i]!, b.view.tgt[i]!, 1e-6, `${a.id} to ${b.id} target`)
      }
    }
  }
})

test("a flight turns the short way and never jumps", () => {
  const from: Pose = { target: [0, 0, 0], distance: 800, pitch: 30, heading: 340 }
  const to: Pose = { target: [0, 0, 0], distance: 800, pitch: 30, heading: 20 }
  close(interpolatePose(from, to, 0.5).heading, 0, 1e-9, "midway through north, not south")
  // Consecutive frames of the longest flight stay close together.
  const a = viewToPose(preset("street").view)
  const b = viewToPose(preset("above").view)
  let prev = poseToView(a).cam
  for (let i = 1; i <= 120; i++) {
    const cam = poseToView(interpolatePose(a, b, i / 120)).cam
    assert.ok(Math.hypot(cam[0] - prev[0], cam[1] - prev[1], cam[2] - prev[2]) < 200, `frame ${i}`)
    prev = cam
  }
})

test("a long flight rises midway so the ground it crosses stays in view", () => {
  const venue = viewToPose(preset("venue").view)
  const battery = viewToPose(preset("battery").view)
  const mid = interpolatePose(venue, battery, 0.5)
  assert.ok(mid.distance > Math.max(venue.distance, battery.distance), `mid distance ${mid.distance}`)
  // Zooming in place does not rise.
  const near: Pose = { ...venue, distance: 200 }
  const zoom = interpolatePose(venue, near, 0.5)
  assert.ok(zoom.distance < venue.distance && zoom.distance > near.distance, `zoom distance ${zoom.distance}`)
})

test("flights take longer the further they go, within limits", () => {
  const venue = viewToPose(preset("venue").view)
  assert.equal(flightMs(venue, venue), MIN_FLIGHT_MS)
  const short = flightMs(venue, viewToPose(preset("street").view))
  const long = flightMs(venue, viewToPose(preset("battery").view))
  assert.ok(short > MIN_FLIGHT_MS && long > short, `short ${short}, long ${long}`)
  const far: Pose = { target: [50_000, 0, 50_000], distance: 20_000, pitch: 89, heading: 180 }
  assert.equal(flightMs(venue, far), MAX_FLIGHT_MS)
})

test("layer toggles keep the URL's layers short and in draw order", () => {
  const all = ["ground", "buildings", "subway", "venue"]
  assert.deepEqual(toggleLayer(null, all, "subway"), ["ground", "buildings", "venue"])
  assert.equal(toggleLayer(["ground", "buildings", "venue"], all, "subway"), null)
  assert.deepEqual(toggleLayer(["venue", "ground"], all, "subway"), ["ground", "subway", "venue"])
  assert.deepEqual(toggleLayer([], all, "venue"), ["venue"])
  assert.deepEqual(toggleLayer(["venue"], all, "venue"), [])
  assert.equal(isLayerShown(null, "subway"), true)
  assert.equal(isLayerShown([], "subway"), false)
  assert.equal(layerName("citibike"), "Citi Bike")
  assert.equal(layerName("weather"), "Weather")
})

test("labels name the venue first, then landmarks, then neighbourhoods", () => {
  assert.equal(PLACES[0]?.name, "598 Broadway")
  const order = { venue: 0, landmark: 1, neighbourhood: 2 }
  for (let i = 1; i < PLACES.length; i++) assert.ok(order[PLACES[i]!.kind] >= order[PLACES[i - 1]!.kind], PLACES[i]!.id)
  assert.equal(new Set(PLACES.map((p) => p.id)).size, PLACES.length)
  // Every place is inside the drawn area: within 6 km of the venue.
  for (const p of PLACES) assert.ok(Math.hypot(p.at[0], p.at[2]) < 6000, p.id)
  const venue = toLatLon({ x: PLACES[0]!.at[0], z: PLACES[0]!.at[2] })
  close(venue.lat, VENUE.lat, 1e-9, "venue lat")
})

test("overlapping labels keep the earlier one", () => {
  const viewport = { width: 1600, height: 900 }
  const kept = placeLabels(
    [
      { id: "venue", left: 100, top: 100, width: 200, height: 40 },
      { id: "soho", left: 250, top: 120, width: 100, height: 40 },
      { id: "tribeca", left: 400, top: 100, width: 100, height: 40 },
    ],
    viewport,
  )
  assert.deepEqual(kept, ["venue", "tribeca"])
})

test("labels stay inside the screen and off the panels", () => {
  const viewport = { width: 1600, height: 900 }
  const toolbar = { left: 400, top: 750, width: 800, height: 110 }
  const kept = placeLabels(
    [
      { id: "left-edge", left: -20, top: 300, width: 100, height: 40 },
      { id: "under-toolbar", left: 600, top: 760, width: 100, height: 40 },
      { id: "bottom-edge", left: 100, top: 880, width: 100, height: 40 },
      { id: "fine", left: 700, top: 400, width: 100, height: 40 },
    ],
    viewport,
    [toolbar],
  )
  assert.deepEqual(kept, ["fine"])
})

// test/fixtures/ui-<preset>.png are real screenshots of each preset (pnpm shot with
// the preset's hash), and test/recordings/ holds the Decisions API's real answers
// for them against checks/ui.json, so this replays every visual check with no key
// and no network.
function checkVisual(...args: string[]) {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  return spawnSync(process.execPath, ["scripts/check-visual.ts", ...args], { encoding: "utf8", env })
}

for (const p of PRESETS) {
  test(`the recorded ${p.label} screenshot passes every UI check, readability included`, () => {
    const png = `test/fixtures/ui-${p.id}.png`
    assert.ok(statSync(png).size < 300_000, `${png} is over 300 KB`)
    const run = checkVisual(png, "checks/ui.json", "--replay")
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.equal(run.stdout.match(/^PASS /gm)?.length, 7, run.stdout)
    assert.match(run.stdout, /^PASS {2}stage_readability {8}(acceptable|good) at/m)
  })
}
