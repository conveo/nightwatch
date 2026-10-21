import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { test } from "node:test"
import { Color, Raycaster, Vector3, type Mesh } from "three"
import {
  convertFootprint,
  convertRing,
  heightMetres,
  MIN_HEIGHT_M,
  toBuilding,
  withinRadius,
  type Geometry,
} from "../scripts/fetch-buildings.ts"
import { FIXTURE_RADIUS_M } from "../src/constants.ts"
import { toLocal, VENUE } from "../src/geo.ts"
import {
  binOf,
  createBuildingsLayer,
  extrude,
  heightColor,
  indexByBin,
  type Building,
  type BuildingsFile,
} from "../src/layers/buildings.ts"

const FIXTURE = "public/fixtures/buildings.json"
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as BuildingsFile

// A square 0.001 degrees on a side with its south-west corner on the venue, closed as
// GeoJSON rings are.
const { lat, lon } = VENUE
const square = [
  [lon, lat],
  [lon + 0.001, lat],
  [lon + 0.001, lat + 0.001],
  [lon, lat + 0.001],
  [lon, lat],
]

function near(actual: number, expected: number, tolerance = 0.11): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)
}

test("a footprint ring converts from degrees to decimetre-rounded local metres", () => {
  const ring = convertRing(square)
  // The closing point is dropped; north is -z and east is +x.
  assert.equal(ring.length, 8)
  const [x0, z0, x1, z1, x2, z2, x3, z3] = ring as [number, number, number, number, number, number, number, number]
  near(x0, 0, 0)
  near(z0, 0, 0)
  near(x1, 84.3, 0.5)
  near(z1, 0, 0)
  near(x2, x1, 0)
  near(z2, -111.3, 0.5)
  near(x3, 0, 0)
  near(z3, z2, 0)
  for (const n of ring) assert.equal(Math.round(n * 10) / 10, n)
})

test("points that round onto the one before are dropped", () => {
  const ring = convertRing([square[0]!, [lon + 1e-7, lat + 1e-7], ...square.slice(1)])
  assert.equal(ring.length, 8)
})

test("holes stay with their polygon and collapsed rings are dropped", () => {
  const hole = [
    [lon + 0.0004, lat + 0.0004],
    [lon + 0.0006, lat + 0.0004],
    [lon + 0.0006, lat + 0.0006],
    [lon + 0.0004, lat + 0.0004],
  ]
  const sliver = [
    [lon, lat],
    [lon + 1e-8, lat],
    [lon, lat],
  ]
  const geometry: Geometry = { type: "MultiPolygon", coordinates: [[square, hole, sliver], [sliver]] }
  const footprints = convertFootprint(geometry)
  assert.equal(footprints.length, 1)
  assert.equal(footprints[0]!.length, 2)
  assert.equal(footprints[0]![1]!.length, 6)
  assert.equal(convertFootprint({ type: "Polygon", coordinates: [square] }).length, 1)
})

test("roof heights convert from feet, with a floor for missing ones", () => {
  assert.equal(heightMetres("171.5"), 52.3)
  assert.equal(heightMetres("1408.4"), 429.3)
  assert.equal(heightMetres(undefined), MIN_HEIGHT_M)
  assert.equal(heightMetres("0"), MIN_HEIGHT_M)
  assert.equal(heightMetres("2"), MIN_HEIGHT_M)
})

test("a row becomes a building; skybridges and rows without a BIN do not", () => {
  const row = { the_geom: { type: "MultiPolygon", coordinates: [[square]] } as Geometry, height_roof: "100" }
  assert.deepEqual(toBuilding({ ...row, bin: "1000001", feature_code: "2100" }), {
    bin: "1000001",
    h: 30.5,
    p: [[convertRing(square)]],
  })
  assert.equal(toBuilding({ ...row, bin: "1000001", feature_code: "2110" }), null)
  assert.equal(toBuilding(row), null)
})

test("the fixture holds at least 100 buildings within the fixture radius, the venue among them", () => {
  assert.ok(fixture.buildings.length >= 100, `${fixture.buildings.length} buildings`)
  assert.equal(withinRadius(fixture.buildings, FIXTURE_RADIUS_M).length, fixture.buildings.length)
  assert.deepEqual(fixture.origin, { lat: VENUE.lat, lon: VENUE.lon })
  assert.ok(statSync(FIXTURE).size < 300 * 1024)
  const venue = fixture.buildings.find((b) => b.bin === VENUE.bin)
  assert.ok(venue != null && venue.h > 30 && venue.h < 80, "the venue is a mid-rise loft")
})

test("a selection names a building by BIN", () => {
  assert.equal(binOf("bin:1007945"), "1007945")
  assert.equal(binOf("bin:"), null)
  assert.equal(binOf("stop:R22"), null)
  assert.equal(binOf(null), null)
  const index = indexByBin(fixture.buildings)
  const [i] = index.get(VENUE.bin)!
  assert.equal(fixture.buildings[i!]!.bin, VENUE.bin)
  assert.equal(index.get("0"), undefined)
})

test("an extruded building has a roof and outward walls, holes included", () => {
  // 10 x 20 m with a 2 x 2 m courtyard, 30 m tall.
  const box: Building = { bin: "1", h: 30, p: [[[0, 0, 10, 0, 10, 20, 0, 20], [4, 4, 6, 4, 6, 6, 4, 6]]] }
  const { geometry, owners } = extrude([box], [0], () => new Color(1, 0, 0))
  const index = geometry.index!.array
  const pos = geometry.getAttribute("position")
  const normal = geometry.getAttribute("normal")
  // Roof: 8 points with one hole is 8 triangles; walls: 8 edges, 2 triangles each.
  assert.equal(index.length / 3, 8 + 16)
  assert.equal(owners.length, index.length / 3)
  assert.ok(owners.every((o) => o === 0))
  geometry.computeBoundingBox()
  assert.deepEqual(geometry.boundingBox!.min.toArray(), [0, 0, 0])
  assert.deepEqual(geometry.boundingBox!.max.toArray(), [10, 30, 20])
  // Every triangle's winding agrees with its normal, so nothing is culled from outside,
  // and every wall faces away from the building's material: out of the box, and into
  // the courtyard.
  const solid = (x: number, z: number) => x > 0 && x < 10 && z > 0 && z < 20 && !(x > 4 && x < 6 && z > 4 && z < 6)
  const [a, b, c, n, mid] = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()]
  for (let t = 0; t < index.length; t += 3) {
    a.fromBufferAttribute(pos, index[t]!)
    b.fromBufferAttribute(pos, index[t + 1]!)
    c.fromBufferAttribute(pos, index[t + 2]!)
    n.fromBufferAttribute(normal, index[t]!)
    mid.copy(a).add(b).add(c).divideScalar(3)
    assert.ok(b.sub(a).cross(c.sub(a)).dot(n) > 0, `triangle ${t / 3} is wound against its normal`)
    if (n.y !== 0) continue
    assert.ok(solid(mid.x - n.x * 0.1, mid.z - n.z * 0.1), `wall ${t / 3} has no building behind it`)
    assert.ok(!solid(mid.x + n.x * 0.1, mid.z + n.z * 0.1), `wall ${t / 3} faces into the building`)
  }
})

test("taller buildings are drawn lighter", () => {
  const lum = (h: number) => {
    const c = heightColor(h)
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  }
  assert.ok(lum(5) < lum(30) && lum(30) < lum(100) && lum(100) < lum(400))
})

function layerOn(file: BuildingsFile | null) {
  return createBuildingsLayer(async (url) => (url.startsWith("fixtures/") ? fixture : file))
}

test("pick returns the BIN under the ray and select highlights that building", async () => {
  const layer = layerOn(null)
  await layer.init({ mode: "fixture", time: null })
  // Loaded, with nothing for the HUD to say.
  assert.equal(layer.summary!(), "")
  // Straight down onto the venue's roof, and up into the sky.
  assert.equal(layer.pick!(new Raycaster(new Vector3(0, 500, 0), new Vector3(0, -1, 0))), `bin:${VENUE.bin}`)
  assert.equal(layer.pick!(new Raycaster(new Vector3(0, 500, 0), new Vector3(0, 1, 0))), null)

  const selection = layer.group.getObjectByName("buildings-selection") as Mesh
  layer.select!(`bin:${VENUE.bin}`)
  assert.ok(selection.visible)
  selection.geometry.computeBoundingBox()
  const venue = fixture.buildings.find((b) => b.bin === VENUE.bin)!
  near(selection.geometry.boundingBox!.max.y, venue.h, 1e-4)
  const { x, z } = toLocal(VENUE)
  assert.ok(selection.geometry.boundingBox!.containsPoint(new Vector3(x, 1, z)))
  layer.select!("bin:0")
  assert.ok(!selection.visible)
  layer.select!(null)
  assert.ok(!selection.visible)
})

test("a selection made before the data loads is shown once it does", async () => {
  const layer = layerOn(null)
  layer.select!(`bin:${VENUE.bin}`)
  await layer.init({ mode: "fixture", time: null })
  assert.ok(layer.group.getObjectByName("buildings-selection")!.visible)
})

test("live mode draws the full download, or says it fell back to the fixture", async () => {
  const full: BuildingsFile = { ...fixture, buildings: fixture.buildings.slice(0, 3) }
  const live = layerOn(full)
  await live.init({ mode: "live", time: null })
  assert.equal(live.summary!(), "")
  const missing = layerOn(null)
  await missing.init({ mode: "recorded", time: null })
  assert.equal(missing.summary!(), "buildings: fixture only")
  const broken = createBuildingsLayer(async (url) => {
    if (url.startsWith("fixtures/")) return fixture
    throw new SyntaxError("Unexpected end of JSON input")
  })
  await broken.init({ mode: "live", time: null })
  assert.equal(broken.summary!(), "buildings: fixture only")
})

// test/fixtures/buildings.png is a real screenshot of the Venue view with the venue
// selected, and test/recordings/ holds the Decisions API's answers for it.
test("the recorded buildings screenshot passes its checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(
    process.execPath,
    ["scripts/check-visual.ts", "test/fixtures/buildings.png", "checks/buildings.json", "--replay"],
    { encoding: "utf8", env },
  )
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 3, run.stdout)
})
