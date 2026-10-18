import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { test } from "node:test"
import { Mesh, ShapeGeometry, Vector3, type BufferGeometry, type Shape } from "three"
import {
  clipLine,
  clipRing,
  flatten,
  groundBox,
  project,
  ringArea,
  simplify,
  toGroundData,
  type FeatureCollection,
} from "../scripts/fetch-ground.ts"
import { AREA } from "../src/constants.ts"
import { toLatLon, toLocal, VENUE, type Local } from "../src/geo.ts"
import { landShapes, ringToPoints, streetPositions, waterShapes, type GroundData } from "../src/layers/ground.ts"

const box = { minX: 0, maxX: 100, minZ: 0, maxZ: 100 }
const pts = (...xz: number[]): Local[] => xz.flatMap((_, i) => (i % 2 === 0 ? [{ x: xz[i]!, z: xz[i + 1]! }] : []))

test("the ground box is AREA plus the margin, in local metres", () => {
  const b = groundBox(0)
  assert.ok(Math.abs(b.minX - toLocal({ lat: VENUE.lat, lon: AREA.west }).x) < 1e-6)
  assert.ok(Math.abs(b.maxZ - toLocal({ lat: AREA.south, lon: VENUE.lon }).z) < 1e-6)
  const m = groundBox(1000)
  assert.ok(Math.abs(m.maxX - b.maxX - 1000) < 1e-6 && Math.abs(b.minZ - m.minZ - 1000) < 1e-6)
})

test("projection takes GeoJSON's [lon, lat] order to metres from the venue", () => {
  const [origin, northEast] = project([
    [VENUE.lon, VENUE.lat],
    [VENUE.lon + 0.001, VENUE.lat + 0.001],
  ])
  assert.ok(Math.abs(origin!.x) < 1e-9 && Math.abs(origin!.z) < 1e-9)
  assert.ok(northEast!.x > 80 && northEast!.z < -100)
})

test("a ring half outside the box is cut along the box edge", () => {
  const ring = clipRing(pts(50, 20, 150, 20, 150, 80, 50, 80, 50, 20), box)
  assert.equal(ring.length, 4)
  assert.equal(Math.abs(ringArea(ring)), 50 * 60)
  assert.ok(ring.every((p) => p.x <= 100))
})

test("a ring inside the box is kept, one outside is dropped", () => {
  assert.equal(clipRing(pts(10, 10, 20, 10, 20, 20), box).length, 3)
  assert.deepEqual(clipRing(pts(200, 200, 300, 200, 300, 300), box), [])
})

test("a ring around the whole box becomes the box", () => {
  const ring = clipRing(pts(-50, -50, 150, -50, 150, 150, -50, 150), box)
  assert.equal(Math.abs(ringArea(ring)), 100 * 100)
})

test("a line that leaves the box and comes back becomes two lines", () => {
  const pieces = clipLine(pts(-10, 50, 50, 50, 50, 150, 80, 150, 80, 50), box)
  assert.equal(pieces.length, 2)
  assert.deepEqual(pieces[0], pts(0, 50, 50, 50, 50, 100))
  assert.deepEqual(pieces[1], pts(80, 100, 80, 50))
  assert.deepEqual(clipLine(pts(-10, -10, -5, -5), box), [])
})

test("simplification drops points on a straight line and keeps corners", () => {
  const line = pts(0, 0, 10, 0.2, 20, 0, 20, 10, 20, 20)
  assert.deepEqual(simplify(line, 1), pts(0, 0, 20, 0, 20, 20))
  assert.equal(simplify(line, 0.1).length, 4)
})

test("flatten rounds to the step and drops repeated points", () => {
  assert.deepEqual(flatten(pts(1.04, -2.26, 1.01, -2.3, 3.5, 4.44), 0.1), [1, -2.3, 3.5, 4.4])
  assert.deepEqual(flatten(pts(0.4, -0.4, 2.6, 1), 1), [0, 0, 3, 1])
})

// Two small boroughs near the venue, one with a hole, a polygon far outside the box,
// a speck smaller than the minimum ring area, and streets of several road types.
function sample(): { boroughs: FeatureCollection; centerline: FeatureCollection } {
  const ll = (x: number, z: number): [number, number] => {
    const p = toLatLon({ x, z })
    return [p.lon, p.lat]
  }
  const square = (x0: number, z0: number, x1: number, z1: number) => [ll(x0, z0), ll(x1, z0), ll(x1, z1), ll(x0, z1), ll(x0, z0)]
  return {
    boroughs: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { boroname: "Manhattan" },
          geometry: {
            type: "MultiPolygon",
            coordinates: [
              [square(-100, -100, 100, 100), square(-30, -30, 30, 30)],
              [square(5000, 5000, 5100, 5100)],
              [square(300, 300, 340, 340)],
            ],
          },
        },
        { type: "Feature", properties: { boroname: "Brooklyn" }, geometry: { type: "Polygon", coordinates: [square(150, -50, 250, 50)] } },
      ],
    },
    centerline: {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { rw_type: "1" }, geometry: { type: "MultiLineString", coordinates: [[ll(-40, 0), ll(40, 0)]] } },
        { type: "Feature", properties: { rw_type: "3" }, geometry: { type: "LineString", coordinates: [ll(60, 0), ll(140, 0)] } },
        { type: "Feature", properties: { rw_type: "14" }, geometry: { type: "LineString", coordinates: [ll(0, 60), ll(0, 140)] } },
        { type: "Feature", properties: { rw_type: "1" }, geometry: { type: "LineString", coordinates: [ll(0, 0), ll(0, 9000)] } },
      ],
    },
  }
}

test("boroughs become land polygons with holes, clipped to the box and rounded", () => {
  const { boroughs, centerline } = sample()
  const data = toGroundData(boroughs, centerline, { box: { minX: -500, maxX: 500, minZ: -500, maxZ: 500 }, step: 1 })
  assert.equal(data.land.length, 2, "the polygon outside the box and the 40 m speck are dropped")
  const [manhattan, brooklyn] = data.land
  assert.equal(manhattan!.length, 2, "outer ring and its hole")
  assert.deepEqual(manhattan![0]!.slice().sort((a, b) => a - b), [-100, -100, -100, -100, 100, 100, 100, 100])
  assert.equal(brooklyn!.length, 1)
  for (const ring of data.land.flat()) assert.ok(ring.every(Number.isInteger))
})

test("only drawable road types become streets, clipped to the box", () => {
  const { boroughs, centerline } = sample()
  const data = toGroundData(boroughs, centerline, { box: { minX: -500, maxX: 500, minZ: -500, maxZ: 500 }, step: 1 })
  assert.equal(data.streets.length, 3, "the ferry route is left out")
  assert.deepEqual(data.streets[2], [0, 0, 0, 500], "the long street stops at the box edge")
})

function area(geometry: BufferGeometry): number {
  const pos = geometry.getAttribute("position")
  const index = geometry.getIndex()!
  let sum = 0
  const [a, b, c] = [new Vector3(), new Vector3(), new Vector3()]
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(pos, index.getX(i))
    b.fromBufferAttribute(pos, index.getX(i + 1))
    c.fromBufferAttribute(pos, index.getX(i + 2))
    sum += b.sub(a).cross(c.sub(a)).length() / 2
  }
  return sum
}

const flatData: GroundData = {
  source: "test",
  box: { minX: -500, maxX: 500, minZ: -500, maxZ: 500 },
  land: [
    [
      [-50, -50, 50, -50, 50, 50, -50, 50],
      [-10, -10, 10, -10, 10, 10, -10, 10],
    ],
  ],
  streets: [[0, 0, 10, 0, 10, 20], [5, 5, 6, 6]],
}

test("land triangulates to its area minus its holes", () => {
  const geometry = new ShapeGeometry(landShapes(flatData))
  assert.ok(Math.abs(area(geometry) - (100 * 100 - 20 * 20)) < 1e-6)
})

test("water covers everything the land does not, lakes included", () => {
  const water = area(new ShapeGeometry(waterShapes(flatData, 1000)))
  const land = area(new ShapeGeometry(landShapes(flatData)))
  assert.ok(Math.abs(water + land - 2000 * 2000) < 1e-3)
  assert.ok(Math.abs(area(new ShapeGeometry(waterShapes(flatData, 1000)[1] as Shape)) - 20 * 20) < 1e-6)
})

test("laid flat, the land lands where its local coordinates say", () => {
  // A ring entirely south of the venue (z > 0) must end up at world z > 0.
  const mesh = new Mesh(new ShapeGeometry(landShapes({ ...flatData, land: [[[0, 100, 10, 100, 10, 110, 0, 110]]] })))
  mesh.rotation.x = -Math.PI / 2
  mesh.updateMatrixWorld()
  const p = new Vector3().fromBufferAttribute(mesh.geometry.getAttribute("position"), 0).applyMatrix4(mesh.matrixWorld)
  assert.ok(p.z >= 100 && p.z <= 110 && Math.abs(p.y) < 1e-9)
  assert.deepEqual(
    ringToPoints([1, 2, 3, 4]).map((v) => [v.x, v.y]),
    [
      [1, -2],
      [3, -4],
    ],
  )
})

test("streets become one segment per pair of points", () => {
  const positions = streetPositions(flatData.streets, 0.5)
  assert.equal(positions.length, 3 * 6)
  assert.deepEqual(Array.from(positions.slice(0, 12)), [0, 0.5, 0, 10, 0.5, 0, 10, 0.5, 0, 10, 0.5, 20])
})

// Even-odd test against every ring of every polygon.
function onLand(data: GroundData, x: number, z: number): boolean {
  let inside = false
  for (const ring of data.land.flat()) {
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const [xi, zi, xj, zj] = [ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!]
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
    }
  }
  return inside
}

test("the fixture's land and water cover the plane once, with no gaps or overlaps", () => {
  const data = JSON.parse(readFileSync("public/fixtures/ground.json", "utf8")) as GroundData
  const half = 10_000
  const land = area(new ShapeGeometry(landShapes(data)))
  const water = area(new ShapeGeometry(waterShapes(data, half)))
  // Within 1,000 square metres out of 400 square kilometres: rounding, not a misplaced triangle.
  assert.ok(Math.abs(land + water - (2 * half) ** 2) < 1000, `land ${land} + water ${water}`)
})

test("the committed fixture is small, covers the area and puts the rivers in the right places", () => {
  const path = "public/fixtures/ground.json"
  assert.ok(statSync(path).size < 300 * 1024, "fixtures stay under 300 KB")
  const data = JSON.parse(readFileSync(path, "utf8")) as GroundData
  assert.ok(data.streets.length > 3000, `${data.streets.length} streets`)
  const area = groundBox(0)
  assert.ok(data.box.minX < area.minX && data.box.maxX > area.maxX && data.box.minZ < area.minZ && data.box.maxZ > area.maxZ)
  assert.ok(onLand(data, 0, 0), "the venue stands on land")
  const at = (lat: number, lon: number) => toLocal({ lat, lon })
  for (const [name, p, land] of [
    ["the Hudson off Houston Street", at(40.7285, -74.016), false],
    ["the East River off Grand Street", at(40.715, -73.972), false],
    ["Washington Square", at(40.7308, -73.9973), true],
    ["the Battery", at(40.7033, -74.017), true],
    ["Brooklyn Heights", at(40.696, -73.994), true],
  ] as const) {
    assert.equal(onLand(data, p.x, p.z), land, name)
  }
})

// test/fixtures/ground.png is a real screenshot of this layer from above, and
// test/recordings/ holds the Decisions API's real answers for it, as in check-visual.test.ts.
test("the recorded ground screenshot passes its checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(process.execPath, ["scripts/check-visual.ts", "test/fixtures/ground.png", "checks/ground.json", "--replay"], {
    encoding: "utf8",
    env,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 3, run.stdout)
})
