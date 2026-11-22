import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { PerspectiveCamera, Vector3 } from "three"
import { MapControls } from "three/addons/controls/MapControls.js"
import { toLocal } from "../src/geo.ts"
import { placeBySlug } from "../src/places.ts"
import { layoutLabels, stemEnd, type LabelInput, type Rect } from "../src/ui/labels.ts"
import {
  MAX_POLAR_ANGLE,
  MIN_CAMERA_Y_M,
  PRESETS,
  applyPreset,
  easeInOutCubic,
  flightMs,
  flyFrame,
  matchPreset,
  polarAngle,
  presetById,
  toggleLayer,
  type CameraPose,
} from "../src/ui/presets.ts"
import { DEFAULT_VIEW, parseViewState, serializeViewState, type Vec3, type ViewState } from "../src/view-state.ts"

const DEG = 180 / Math.PI

// A camera like main.ts's (45° vertical field of view) on a 16:9 screen, placed the
// way MapControls places it: at `cam`, looking at `tgt`.
function screen(pose: CameraPose, point: Vec3): { x: number; y: number; inFront: boolean } {
  const camera = new PerspectiveCamera(45, 16 / 9, 1, 20000)
  camera.position.set(...pose.cam)
  camera.lookAt(new Vector3(...pose.tgt))
  camera.updateMatrixWorld()
  const v = new Vector3(...point).project(camera)
  return { x: v.x, y: v.y, inFront: v.z > -1 && v.z < 1 }
}

function onScreen(p: { x: number; y: number; inFront: boolean }): boolean {
  return p.inFront && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1
}

function place(slug: string, y = 0): Vec3 {
  const { x, z } = toLocal(placeBySlug(slug)!)
  return [x, y, z]
}

// Compass heading of the camera's view: 0 = north, 90 = east (x east, z south).
function heading(pose: CameraPose): number {
  const dx = pose.tgt[0] - pose.cam[0]
  const dz = pose.tgt[2] - pose.cam[2]
  return (Math.atan2(dx, -dz) * DEG + 360) % 360
}

test("the six presets from the plan, in order", () => {
  assert.deepEqual(
    PRESETS.map((p) => p.name),
    ["Belfort", "Graslei", "Gravensteen", "Sint-Baafs", "From above", "Street level"],
  )
  assert.equal(presetById("street")?.name, "Street level")
  assert.equal(presetById("nowhere"), null)
})

test("each preset survives a round trip through the URL and changes only the camera", () => {
  const view: ViewState = {
    ...DEFAULT_VIEW,
    sel: "place:gravensteen",
    mode: "recorded",
    t: "2026-11-25T18:30:00Z",
    layers: ["buildings", "lichtplan"],
    light: "night",
    ask: "park:gravensteen",
  }
  for (const preset of PRESETS) {
    const next = applyPreset(view, preset)
    assert.deepEqual(next, { ...view, cam: preset.cam, tgt: preset.tgt }, preset.id)
    assert.deepEqual(parseViewState(serializeViewState(next)), next, preset.id)
    assert.equal(matchPreset(parseViewState(serializeViewState(next))), preset.id)
  }
})

test("applying a preset copies its camera, so moving the view later leaves the preset alone", () => {
  const preset = presetById("belfort")!
  const next = applyPreset(DEFAULT_VIEW, preset)
  next.cam[0] = 12345
  assert.notEqual(preset.cam[0], 12345)
})

test("no preset breaks the controls' limits, so the controls never move it", () => {
  for (const preset of PRESETS) {
    assert.ok(polarAngle(preset) < MAX_POLAR_ANGLE, `${preset.id}: ${polarAngle(preset) * DEG}°`)
    assert.ok(preset.cam[1] >= MIN_CAMERA_Y_M, `${preset.id} is above the street`)
  }
})

test("each preset, read back from the URL, stays exactly where it is under the app's MapControls", () => {
  // The same controls and limits as main.ts; update() clamps a view that breaks them.
  for (const preset of PRESETS) {
    const view = parseViewState(serializeViewState(applyPreset(DEFAULT_VIEW, preset)))
    const camera = new PerspectiveCamera(45, 16 / 9, 1, 20000)
    // No DOM element: the controls only do their maths here.
    const controls = new MapControls(camera)
    controls.maxPolarAngle = MAX_POLAR_ANGLE
    camera.position.set(...view.cam)
    controls.target.set(...view.tgt)
    controls.update()
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(camera.position.getComponent(i) - preset.cam[i]!) < 1e-6, `${preset.id} camera`)
      assert.ok(Math.abs(controls.target.getComponent(i) - preset.tgt[i]!) < 1e-6, `${preset.id} target`)
    }
  }
})

test("Street level looks up at the towers, which the old limit (level or below) forbade", () => {
  const street = presetById("street")!
  assert.ok(street.tgt[1] >= 30 && street.tgt[1] <= 45, `target ${street.tgt[1]} m up`)
  assert.ok(polarAngle(street) > Math.PI / 2, "the view tilts above the horizon")
})

test("each landmark preset frames its landmark", () => {
  for (const [id, slug] of [
    ["belfort", "belfort"],
    ["graslei", "graslei"],
    ["gravensteen", "gravensteen"],
    ["sint-baafs", "sint-baafs"],
  ] as const) {
    const preset = presetById(id)!
    const p = place(slug)
    assert.ok(Math.hypot(preset.tgt[0] - p[0], preset.tgt[2] - p[2]) < 1, `${id} targets its place`)
    const s = screen(preset, p)
    assert.ok(onScreen(s) && Math.abs(s.x) < 0.2 && Math.abs(s.y) < 0.4, `${id} has its landmark near the middle`)
    const down = 90 - polarAngle(preset) * DEG
    assert.ok(down > 20 && down < 45, `${id} looks down ${down}°`)
  }
})

test("From above sees every landmark from high up, north at the top", () => {
  const above = presetById("above")!
  assert.ok(above.cam[1] >= 800)
  assert.ok(polarAngle(above) * DEG < 20, "looks almost straight down")
  for (const slug of ["belfort", "sint-baafs", "sint-niklaas", "sint-michielsbrug", "graslei", "gravensteen", "stadhuis", "vrijdagmarkt"]) {
    assert.ok(onScreen(screen(above, place(slug))), `${slug} is on screen`)
  }
  assert.ok(screen(above, place("gravensteen")).y > screen(above, place("belfort")).y, "the Gravensteen (north) is higher up")
})

test("Street level stands on the Sint-Michielsbrug at eye height, looking east at the three towers in a row", () => {
  const street = presetById("street")!
  const bridge = place("sint-michielsbrug")
  assert.ok(Math.hypot(street.cam[0] - bridge[0], street.cam[2] - bridge[2]) < 15, "on the bridge")
  assert.ok(street.cam[1] >= 1.5 && street.cam[1] <= 8, `eye height, not ${street.cam[1]} m`)
  const h = heading(street)
  assert.ok(h > 80 && h < 110, `looks east, not ${h}°`)
  // The towers' tops (from the buildings layer: 60, 90 and 81 m) and their feet.
  const towers = [place("sint-niklaas", 60), place("belfort", 90), place("sint-baafs", 81)].map((p) => screen(street, p))
  for (const t of towers) assert.ok(onScreen(t), "each tower top is in the picture")
  const xs = towers.map((t) => t.x)
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, "left to right: Sint-Niklaas, the Belfry, Sint-Baafs")
  assert.ok(Math.max(...xs) - Math.min(...xs) < 0.6, "side by side in the middle of the picture")
  for (const slug of ["sint-niklaas", "belfort", "sint-baafs"]) {
    assert.ok(screen(street, place(slug)).y < 0.1, `${slug} stands on the horizon, seen from street level`)
  }
})

test("a flight starts and ends exactly at its two views, easing in and out", () => {
  const from = presetById("street")!
  const to = presetById("above")!
  assert.deepEqual(flyFrame(from, to, 0), { cam: from.cam, tgt: from.tgt })
  assert.deepEqual(flyFrame(from, to, 1), { cam: to.cam, tgt: to.tgt })
  assert.deepEqual(flyFrame(from, to, 1.5), { cam: to.cam, tgt: to.tgt })
  assert.equal(easeInOutCubic(0), 0)
  assert.equal(easeInOutCubic(0.5), 0.5)
  assert.equal(easeInOutCubic(1), 1)
  assert.ok(easeInOutCubic(0.1) < 0.1 && easeInOutCubic(0.9) > 0.9, "slow at both ends")
  let last = -1
  for (let t = 0; t <= 1; t += 0.05) {
    const e = easeInOutCubic(t)
    assert.ok(e >= last)
    last = e
  }
})

test("a flight between two low views rises over the roofs", () => {
  const from = presetById("graslei")!
  const to = presetById("sint-baafs")!
  const mid = flyFrame(from, to, 0.5)
  const straight = (from.cam[1] + to.cam[1]) / 2
  assert.ok(mid.cam[1] > straight + 100, `mid-flight at ${mid.cam[1]} m`)
  for (let t = 0; t <= 1; t += 0.1) assert.ok(flyFrame(from, to, t).cam[1] >= Math.min(from.cam[1], to.cam[1]) - 1e-9)
})

test("longer flights take longer, within bounds", () => {
  const a = presetById("belfort")!
  const b = presetById("sint-baafs")!
  const far = presetById("above")!
  assert.ok(flightMs(a, b) < flightMs(presetById("street")!, far))
  for (const x of PRESETS) for (const y of PRESETS) assert.ok(flightMs(x, y) >= 800 && flightMs(x, y) <= 2400)
})

test("a camera moved off a preset no longer matches it", () => {
  const preset = presetById("gravensteen")!
  assert.equal(matchPreset(preset), "gravensteen")
  assert.equal(matchPreset({ cam: [preset.cam[0] + 5, preset.cam[1], preset.cam[2]], tgt: preset.tgt }), null)
  assert.equal(matchPreset(DEFAULT_VIEW), null)
})

test("layer switches write `layers`, and every layer on is no `layers` at all", () => {
  const all = ["ground", "buildings", "lichtplan", "origin"]
  assert.deepEqual(toggleLayer(null, all, "lichtplan"), ["ground", "buildings", "origin"])
  assert.equal(toggleLayer(["ground", "buildings", "origin"], all, "lichtplan"), null)
  assert.deepEqual(toggleLayer([], all, "buildings"), ["buildings"])
  assert.deepEqual(toggleLayer(["buildings"], all, "buildings"), [])
  assert.deepEqual(toggleLayer(["origin", "ground"], all, "buildings"), ["ground", "buildings", "origin"], "keeps the layer order")
  assert.deepEqual(parseViewState(serializeViewState({ ...DEFAULT_VIEW, layers: toggleLayer(null, all, "ground") })).layers, [
    "buildings",
    "lichtplan",
    "origin",
  ])
})

const VIEWPORT = { w: 1600, h: 900 }

function label(id: string, x: number, y: number, foot: Rect | null = null, shafts: Rect[] = []): LabelInput {
  return { id, anchor: { x, y }, foot, shafts, w: 160, h: 40 }
}

function rects(inputs: LabelInput[], layout: ReturnType<typeof layoutLabels>): Rect[] {
  return inputs.flatMap((l) => {
    const at = layout.get(l.id)
    return at == null ? [] : [{ x: at.x, y: at.y, w: l.w, h: l.h }]
  })
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

test("a label hangs above its dot on a stem when there is room", () => {
  const at = layoutLabels([label("belfort", 800, 450)], VIEWPORT).get("belfort")
  assert.deepEqual(at, { x: 720, y: 450 - 44 - 40, pin: true })
  assert.deepEqual(stemEnd({ x: 800, y: 450 }, { x: at!.x, y: at!.y, w: 160, h: 40 }), { x: 800, y: 406 })
})

test("labels never overlap one another or cover another label's dot", () => {
  const inputs = [label("a", 800, 450), label("b", 880, 470), label("c", 700, 430), label("d", 1000, 500), label("e", 600, 420)]
  const layout = layoutLabels(inputs, VIEWPORT)
  const placed = rects(inputs, layout)
  assert.ok(placed.length >= 4, "most of them still find a place")
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.ok(!intersects(placed[i]!, placed[j]!))
  for (const r of placed) for (const l of inputs) assert.ok(!intersects(r, { x: l.anchor!.x - 2, y: l.anchor!.y - 2, w: 4, h: 4 }))
})

test("the first label in the list wins a contested spot", () => {
  const layout = layoutLabels([label("first", 800, 450), label("second", 800, 452)], VIEWPORT)
  assert.equal(layout.get("first")!.y, 450 - 44 - 40)
  assert.notEqual(layout.get("second"), undefined)
  assert.notEqual(layout.get("second")?.y, 450 - 44 - 40)
})

test("labels keep clear of the title and the panels, and of the screen's edges", () => {
  const title: Rect = { x: 16, y: 16, w: 260, h: 70 }
  const bar: Rect = { x: 16, y: 800, w: 1000, h: 64 }
  const inputs = [label("near-title", 150, 120), label("near-bar", 400, 780), label("edge", 1590, 300), label("under", 100, 40)]
  const layout = layoutLabels(inputs, VIEWPORT, [title, bar])
  for (const r of rects(inputs, layout)) {
    assert.ok(!intersects(r, title) && !intersects(r, bar))
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= VIEWPORT.w && r.y + r.h <= VIEWPORT.h)
  }
  assert.equal(layout.get("under"), null, "a dot under the title hides its label")
})

test("a dot off screen or behind the camera hides its label", () => {
  const layout = layoutLabels([label("left", -10, 300), { id: "behind", anchor: null, foot: null, shafts: [], w: 160, h: 40 }], VIEWPORT)
  assert.equal(layout.get("left"), null)
  assert.equal(layout.get("behind"), null)
})

test("seen from overhead, a label sits beside its landmark's foot, not on it", () => {
  // The tower's top falls inside its own foot: the Belfry's red ring, from above.
  const foot: Rect = { x: 760, y: 410, w: 80, h: 80 }
  // The Stadhuis, seen at an angle: its dot (25 m up) is above its foot.
  const inputs = [label("belfort", 802, 444, foot), label("stadhuis", 810, 280, { x: 780, y: 300, w: 60, h: 60 })]
  const layout = layoutLabels(inputs, VIEWPORT)
  const belfort = layout.get("belfort")!
  assert.equal(belfort.pin, false, "no dot or stem inside the foot")
  assert.equal(layout.get("stadhuis")!.pin, true)
  for (const r of rects(inputs, layout)) {
    assert.ok(!intersects(r, foot), "no label covers the Belfry's foot")
    assert.ok(!intersects(r, { x: 780, y: 300, w: 60, h: 60 }), "nor the Stadhuis's")
  }
})

test("beside a tower, a label stands clear of the tower's shaft, on a stem from its top", () => {
  // Seen from the street: the Belfry's dot lies on its own shaft (the base's red beam
  // rises above the tower), so the label cannot go above it and stands beside it.
  const shaft: Rect = { x: 744, y: -200, w: 12, h: 600 }
  const layout = layoutLabels([label("belfort", 750, 120, null, [shaft])], VIEWPORT)
  const at = layout.get("belfort")!
  assert.equal(at.pin, true, "a dot on its own tower keeps its stem")
  assert.ok(!intersects({ x: at.x, y: at.y, w: 160, h: 40 }, shaft))
  assert.ok(Math.abs(at.y + 20 - 120) < 1, "level with the tower's top")
  assert.ok(at.x >= 756 && at.x < 790, "just beside the shaft")
})

test("a dot on another landmark's shaft gives up its stem", () => {
  const shaft: Rect = { x: 740, y: 100, w: 20, h: 500 }
  const layout = layoutLabels([label("tower", 750, 300, null, [shaft]), label("behind", 758, 200)], VIEWPORT)
  assert.equal(layout.get("behind")?.pin, false)
})

test("a label that could only hang far from its dot is hidden instead", () => {
  // The dot is on a tall tower whose neighbours fill both sides, so the label could
  // only go far above or below the tower, further than a stem reaches.
  const shaft: Rect = { x: 780, y: 100, w: 40, h: 700 }
  const left = label("left", 650, 450, { x: 560, y: 300, w: 210, h: 300 })
  const right = label("right", 950, 450, { x: 830, y: 300, w: 210, h: 300 })
  const layout = layoutLabels([label("lost", 800, 450, null, [shaft]), left, right], VIEWPORT)
  assert.equal(layout.get("lost"), null)
})

// test/fixtures/ui-*.png are real screenshots of presets and test/recordings/ holds
// the Decisions API's answers for them, so CI re-checks them with no key.
function checkVisual(png: string, checks: string) {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  return spawnSync(process.execPath, ["scripts/check-visual.ts", png, checks, "--replay"], { encoding: "utf8", env })
}

test("the recorded From above screenshot passes the checks every preset passes", () => {
  const run = checkVisual("test/fixtures/ui-above.png", "checks/ui.json")
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 6, run.stdout)
})
