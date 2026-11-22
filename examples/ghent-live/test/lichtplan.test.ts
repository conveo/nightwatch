import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { test } from "node:test"
import { Light, Ray, Raycaster, SpotLight, Vector3, type Object3D } from "three"
import { ORIGIN } from "../src/geo.ts"
import {
  areaRect,
  chooseLitPoints,
  clipPolyline,
  clipToArea,
  createLichtplanLayer,
  encodeFile,
  inRect,
  lightRig,
  lineLength,
  linesFromGeoJson,
  MAX_REAL_LIGHTS,
  parseLichtplanFile,
  parsePoiSelection,
  pickPoi,
  pointsFromGeoJson,
  poiKind,
  poiSelection,
  ribbonGeometry,
  type LichtplanPoint,
  type Rect,
} from "../src/layers/lichtplan.ts"

const FIXTURE = "public/fixtures/lichtplan.json"
const fixture = () => parseLichtplanFile(JSON.parse(readFileSync(FIXTURE, "utf8")))

// The objectids of the Street-level view's three towers and of the bridge it stands on.
const BELFORT = 2251
const SINT_BAAFS = 2253
const SINT_NIKLAAS = 2254
const SINT_MICHIELSBRUG = 2235

const point = (id: number, kind: string, nl: string, x: number, z: number): LichtplanPoint => ({ id, n: null, kind, nl, en: null, x, z })

// --- Parsing ---------------------------------------------------------------------

test("a Lichtplan point from Stad Gent's GeoJSON lands in scene metres", () => {
  const [belfry, east] = pointsFromGeoJson([
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [ORIGIN.lon, ORIGIN.lat] },
      properties: { objectid: 2251, volgnummer: 9, soort: "Belfort", naam_nl: "Belfort en Lakenhalle", naam_en: "Belfry and Cloth Hall" },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [ORIGIN.lon + 0.001, ORIGIN.lat] },
      properties: { objectid: 7, soort: " Brug ", naam_nl: "Een brug", naam_en: null },
    },
  ])
  const { x, z, ...rest } = belfry!
  assert.deepEqual(rest, { id: 2251, n: 9, kind: "Belfort", nl: "Belfort en Lakenhalle", en: "Belfry and Cloth Hall" })
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(z) < 1e-9, "the Belfry is the scene origin")
  assert.equal(east!.kind, "Brug")
  assert.equal(east!.en, null)
  assert.ok(Math.abs(east!.x - 70) < 1, `0.001° of longitude is about 70 m in Ghent, got ${east!.x}`)
  assert.ok(Math.abs(east!.z) < 1e-9)
})

test("a point without a geometry falls back to geo_point_2d; one without an id or a position is skipped", () => {
  const points = pointsFromGeoJson([
    { geometry: null, properties: { objectid: 1, naam_nl: "a", geo_point_2d: { lat: ORIGIN.lat, lon: ORIGIN.lon } } },
    { geometry: { type: "Point", coordinates: [3.72, 51.05] }, properties: { naam_nl: "no id" } },
    { geometry: null, properties: { objectid: 2, naam_nl: "no position" } },
    { geometry: { type: "Point", coordinates: ["x", 51] }, properties: { objectid: 3 } },
  ])
  assert.deepEqual(
    points.map((p) => [p.id, Math.abs(p.x) < 1e-9, Math.abs(p.z) < 1e-9]),
    [[1, true, true]],
  )
})

test("the walk's lines parse, multi-lines split, and a line published twice is drawn once (the walk's copy kept)", () => {
  const coords = [
    [ORIGIN.lon, ORIGIN.lat],
    [ORIGIN.lon + 0.001, ORIGIN.lat],
    [ORIGIN.lon + 0.001, ORIGIN.lat],
    [ORIGIN.lon + 0.001, ORIGIN.lat - 0.001],
  ]
  const lines = linesFromGeoJson([
    { geometry: { type: "LineString", coordinates: coords }, properties: { objectid: 325, type: "uitbreiding" } },
    { geometry: { type: "LineString", coordinates: coords }, properties: { objectid: 332, type: "hoofdroute" } },
    {
      geometry: { type: "MultiLineString", coordinates: [coords.slice(0, 2), [[ORIGIN.lon, ORIGIN.lat - 0.002], [ORIGIN.lon, ORIGIN.lat - 0.003]]] },
      properties: { objectid: 329, type: "doorsteek" },
    },
    { geometry: { type: "Point", coordinates: coords[0] }, properties: { objectid: 1 } },
  ])
  assert.deepEqual(
    lines.map((l) => [l.id, l.type, l.points.length]),
    [
      [332, "hoofdroute", 3], // the repeated point is dropped
      [329, "doorsteek", 2],
      [329, "doorsteek", 2],
    ],
  )
})

test("the fixture round-trips through its file format", () => {
  const data = fixture()
  const again = parseLichtplanFile(JSON.parse(JSON.stringify(encodeFile(data, "test"))))
  assert.deepEqual(again, data)
  assert.throws(() => parseLichtplanFile({ points: [] }), /expected/)
  assert.throws(() => parseLichtplanFile({ points: [{ id: 1, x: 0 }], lines: [] }), /needs id, x and z/)
  assert.throws(() => parseLichtplanFile({ points: [], lines: [{ id: 1, xz: [1, 2, 3] }] }), /even list/)
})

// --- Clipping and the ribbon -----------------------------------------------------------

const box: Rect = { minX: 0, minZ: 0, maxX: 100, maxZ: 100 }

test("a line is clipped to the area: cut at the edge, split where it leaves and comes back", () => {
  assert.deepEqual(
    clipPolyline(
      [
        [-50, 50],
        [50, 50],
        [50, 20],
      ],
      box,
    ),
    [
      [
        [0, 50],
        [50, 50],
        [50, 20],
      ],
    ],
  )
  const outAndBack = clipPolyline(
    [
      [10, 10],
      [10, 150],
      [90, 150],
      [90, 10],
    ],
    box,
  )
  assert.deepEqual(outAndBack, [
    [
      [10, 10],
      [10, 100],
    ],
    [
      [90, 100],
      [90, 10],
    ],
  ])
  assert.deepEqual(
    clipPolyline(
      [
        [-10, -10],
        [-10, 200],
      ],
      box,
    ),
    [],
  )
  // Ends inside stay exact, so a long line inside the area stays one piece.
  const zigzag = Array.from({ length: 50 }, (_, i): [number, number] => [1.1 + i * 1.7, i % 2 === 0 ? 3.3 : 97.7])
  assert.equal(clipPolyline(zigzag, box).length, 1)
})

test("clipping to the area keeps points inside it and drops short leftovers of the walk", () => {
  const r = areaRect()
  const data = clipToArea(
    {
      points: [point(1, "", "in", 0, 0), point(2, "", "out", r.maxX + 10, 0)],
      lines: [
        { id: 9, type: "hoofdroute", points: [[0, 0], [r.maxX + 100, 0]] },
        { id: 8, type: "uitbreiding", points: [[r.maxX - 3, 50], [r.maxX + 100, 50]] },
      ],
    },
    r,
  )
  assert.deepEqual(
    data.points.map((p) => p.id),
    [1],
  )
  assert.deepEqual(
    data.lines.map((l) => [l.id, Math.round(lineLength(l.points))]),
    [[9, Math.round(r.maxX)]],
  )
})

test("the walk's ribbon has two vertices per point, the given width, and faces up", () => {
  const g = ribbonGeometry(
    [
      [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
    ],
    10,
    0.5,
  )
  const pos = g.getAttribute("position")
  assert.equal(pos.count, 6)
  assert.equal(g.getIndex()!.count, 12)
  for (let i = 0; i < pos.count; i++) assert.equal(pos.getY(i), 0.5)
  // The first two vertices are the ribbon's two edges at the start: 10 m apart.
  assert.ok(Math.abs(Math.hypot(pos.getX(0) - pos.getX(1), pos.getZ(0) - pos.getZ(1)) - 10) < 1e-9)
  // The first triangle's normal points up.
  const [a, b, c] = [0, 1, 2].map((k) => new Vector3().fromBufferAttribute(pos, g.getIndex()!.getX(k)))
  const normal = new Vector3().subVectors(b!, a!).cross(new Vector3().subVectors(c!, a!))
  assert.ok(normal.y > 0, `normal ${normal.toArray()}`)
  // The mitred corner is wider than the ribbon, but capped.
  const corner = Math.hypot(pos.getX(2) - pos.getX(3), pos.getZ(2) - pos.getZ(3))
  assert.ok(corner > 10 && corner <= 20, `corner ${corner}`)
})

// --- The eight lights ------------------------------------------------------------------

test("towers and bridges are told apart from the other lit places", () => {
  assert.equal(poiKind({ kind: "Belfort", nl: "Belfort en Lakenhalle" }), "tower")
  assert.equal(poiKind({ kind: "Kathedraal", nl: "Sint-Baafskathedraal" }), "tower")
  assert.equal(poiKind({ kind: "Kerk van toeristische waarde", nl: "Sint-Niklaaskerk" }), "tower")
  assert.equal(poiKind({ kind: "Kasteel", nl: "Gravensteen" }), "tower")
  assert.equal(poiKind({ kind: "Architecturale plaats", nl: "Het Toreken - Vrijdagmarkt" }), "tower")
  assert.equal(poiKind({ kind: "Brug", nl: "Sint-Michielsbrug" }), "bridge")
  assert.equal(poiKind({ kind: "Straat", nl: "Gras-en Korenlei" }), "other")
  assert.equal(poiKind({ kind: "Stadhuis", nl: "Botermarkt, Stadhuis" }), "other")
})

test("at most eight points get a real light: the three towers of the street view, the bridge, then the nearest towers", () => {
  const data = fixture()
  const lit = chooseLitPoints(data.points)
  assert.equal(MAX_REAL_LIGHTS, 8)
  assert.equal(lit.length, 8)
  const ids = lit.map((p) => p.id)
  for (const id of [BELFORT, SINT_BAAFS, SINT_NIKLAAS, SINT_MICHIELSBRUG]) assert.ok(ids.includes(id), `poi:${id} lit`)
  assert.ok(lit.every((p) => poiKind(p) !== "other"))
  assert.equal(new Set(ids).size, ids.length)
  // The same answer every time, and no more than asked for.
  assert.deepEqual(
    chooseLitPoints([...data.points].reverse()).map((p) => p.id),
    ids,
  )
  assert.deepEqual(
    chooseLitPoints(data.points, 3)
      .map((p) => p.id)
      .sort(),
    [BELFORT, SINT_BAAFS, SINT_NIKLAAS].sort(),
  )
  assert.deepEqual(chooseLitPoints(data.points, 0), [])
  assert.deepEqual(chooseLitPoints([point(1, "Straat", "a street", 0, 0)]), [])
})

test("slots the towers cannot fill go to more bridges, and bridges never take more than a quarter otherwise", () => {
  const bridges = Array.from({ length: 10 }, (_, i) => point(100 + i, "Brug", `brug ${i}`, i * 10, 0))
  const towers = Array.from({ length: 10 }, (_, i) => point(200 + i, "Kerk", `kerk ${i}`, i * 10, 5))
  assert.equal(chooseLitPoints([...bridges, ...towers]).filter((p) => poiKind(p) === "bridge").length, 2)
  assert.equal(chooseLitPoints([...bridges, ...towers.slice(0, 3)]).length, 8)
  assert.equal(chooseLitPoints(bridges).length, 8)
})

test("a tower's floodlight stands west-south-west of it, lower than its top, and aims up at it; a bridge's light is over the deck", () => {
  const rig = lightRig(point(1, "Belfort", "Belfort", 0, 0))
  assert.equal(rig.type, "spot")
  assert.ok(rig.position[0] < 0 && rig.position[2] > 0, `position ${rig.position}`)
  assert.ok(rig.position[0] < rig.position[2] * -2, "more west than south")
  assert.ok(Math.hypot(rig.position[0], rig.position[2]) > 20)
  assert.deepEqual([rig.target[0], rig.target[2]], [0, 0])
  // Aimed up: the target is higher than the light, and both are below a tall tower's top.
  assert.ok(rig.target[1] > rig.position[1] && rig.target[1] < 90, `target ${rig.target}`)
  const bridge = lightRig(point(2, "Brug", "Sint-Michielsbrug", -309, -19))
  assert.equal(bridge.type, "point")
  assert.deepEqual([bridge.position[0], bridge.position[2]], [-309, -19])
})

// --- Selection and picking ------------------------------------------------------------

test("a Lichtplan selection is poi:<objectid>", () => {
  assert.equal(poiSelection(2173), "poi:2173")
  assert.equal(parsePoiSelection("poi:2173"), 2173)
  assert.equal(parsePoiSelection("bldg:2173"), null)
  assert.equal(parsePoiSelection("poi:abc"), null)
  assert.equal(parsePoiSelection(null), null)
})

test("picking finds the point the ray meets first, and nothing when it misses", () => {
  const points = [point(1, "", "near", 0, 0), point(2, "", "far", 100, 0)]
  const along = new Ray(new Vector3(-50, 6, 0), new Vector3(1, 0, 0))
  assert.equal(pickPoi(along, points), 1)
  assert.equal(pickPoi(new Ray(new Vector3(150, 6, 0), new Vector3(-1, 0, 0)), points), 2)
  assert.equal(pickPoi(new Ray(new Vector3(-50, 6, 50), new Vector3(1, 0, 0)), points), null)
})

// --- The layer, on the committed fixture ---------------------------------------------

function shownInScene(o: Object3D): boolean {
  for (let p: Object3D | null = o; p != null; p = p.parent) if (!p.visible) return false
  return true
}

async function loadedLayer() {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(readFileSync(FIXTURE, "utf8"))) as typeof fetch
  try {
    const layer = createLichtplanLayer()
    await layer.init({ mode: "fixture", time: null })
    return layer
  } finally {
    globalThis.fetch = realFetch
  }
}

test("at night the layer has at most eight real lights, the three towers floodlit; by day none", async () => {
  const layer = await loadedLayer()
  const lights: Light[] = []
  layer.group.traverse((o) => {
    if ((o as Light).isLight) lights.push(o as Light)
  })
  assert.ok(lights.length <= MAX_REAL_LIGHTS && lights.length > 0, `${lights.length} lights`)
  const spots = lights.filter((l) => (l as SpotLight).isSpotLight).map((l) => l.name)
  for (const id of [BELFORT, SINT_BAAFS, SINT_NIKLAAS]) assert.ok(spots.includes(`lichtplan-light-${id}`), `poi:${id} floodlit`)

  layer.setLight!("night")
  assert.ok(lights.every(shownInScene))
  const walk = layer.group.getObjectByName("lichtplan-walk-night")!
  assert.ok(shownInScene(walk))
  assert.ok(!shownInScene(layer.group.getObjectByName("lichtplan-walk-day")!))

  layer.setLight!("day")
  assert.ok(lights.every((l) => !shownInScene(l)))
  assert.ok(!shownInScene(walk))
  assert.ok(shownInScene(layer.group.getObjectByName("lichtplan-walk-day")!))
  assert.ok(shownInScene(layer.group.getObjectByName("lichtplan-markers")!))
})

test("the layer picks and selects poi:<objectid>", async () => {
  const layer = await loadedLayer()
  const ray = new Raycaster(new Vector3(0, 500, 0), new Vector3(0, -1, 0))
  assert.equal(layer.pick!(ray), `poi:${BELFORT}`)
  const marker = layer.group.getObjectByName("lichtplan-selection")!
  layer.select!(`poi:${SINT_BAAFS}`)
  assert.ok(marker.visible)
  const baafs = fixture().points.find((p) => p.id === SINT_BAAFS)!
  assert.deepEqual([marker.position.x, marker.position.z], [baafs.x, baafs.z])
  layer.select!("bldg:1362089")
  assert.ok(!marker.visible)
  layer.select!(null)
  assert.ok(!marker.visible)
})

// --- The committed fixture -------------------------------------------------------------

test("the fixture holds the Lichtplan inside the area, small", () => {
  const data = fixture()
  const r = areaRect()
  assert.ok(statSync(FIXTURE).size < 300 * 1024)
  assert.ok(data.points.length >= 45, `${data.points.length} points`)
  assert.ok(data.points.every((p) => inRect([p.x, p.z], r)))
  assert.equal(new Set(data.points.map((p) => p.id)).size, data.points.length)
  const walk = data.lines.filter((l) => l.type === "hoofdroute")
  assert.ok(walk.reduce((sum, l) => sum + lineLength(l.points), 0) > 3000, "the main walk is over 3 km")
  // Line ends clipped to the edge may round 0.05 m past it.
  const padded = { minX: r.minX - 0.1, minZ: r.minZ - 0.1, maxX: r.maxX + 0.1, maxZ: r.maxZ + 0.1 }
  assert.ok(data.lines.every((l) => l.points.every((p) => inRect(p, padded))))
  const belfry = data.points.find((p) => p.id === BELFORT)!
  assert.ok(Math.hypot(belfry.x, belfry.z) < 1, "the Belfry is the scene origin")
})

// --- Recorded visual checks ------------------------------------------------------------

// test/fixtures/lichtplan.png (night, taken with the buildings of T1 in the scene) and
// test/fixtures/lichtplan-day.png are real screenshots of the views in the check files,
// and test/recordings/ holds the Decisions API's real answers for them, so these run
// the whole command with no key and no network.
function checkVisual(...args: string[]) {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  return spawnSync(process.execPath, ["scripts/check-visual.ts", ...args], { encoding: "utf8", env })
}

test("the recorded night screenshot passes its checks: warm lights on the towers, a glowing path", () => {
  const run = checkVisual("test/fixtures/lichtplan.png", "checks/lichtplan.json", "--replay")
  assert.equal(run.status, 0, run.stderr + run.stdout)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 2, run.stdout)
})

test("the recorded day screenshot passes its negative control: no glowing path", () => {
  const run = checkVisual("test/fixtures/lichtplan-day.png", "checks/lichtplan-day.json", "--replay")
  assert.equal(run.status, 0, run.stderr + run.stdout)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 1, run.stdout)
})

test("the night screenshot does not replay against the day checks (each recording is for its own screenshot)", () => {
  const run = checkVisual("test/fixtures/lichtplan.png", "checks/lichtplan-day.json", "--replay")
  assert.equal(run.status, 2)
  assert.match(run.stderr, /no recorded answer/)
})
