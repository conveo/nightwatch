import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { test } from "node:test"
import { WATER_LEVEL_M } from "../src/constants.ts"
import {
  areaRect,
  bridgeEdges,
  clipRing,
  decodeRing,
  edgeRuns,
  encodeRing,
  parseGroundFile,
  pointInPolygon,
  polygonArea,
  polygonsFromGeometry,
  quayEdges,
  ringArea,
  ringFromLonLat,
  simplifyRing,
  surfaceGeometry,
  triangulate,
  type Polygon,
  type Rect,
  type Ring,
  type XZ,
} from "../src/layers/ground.ts"

const square = (x: number, z: number, size: number): Ring => [
  [x, z],
  [x + size, z],
  [x + size, z + size],
  [x, z + size],
]
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps
const BIG: Rect = { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 }

test("GeoJSON lon/lat rings become metres from the Belfry, without the closing point", () => {
  // The Belfry, the Sint-Michielsbrug (310 m west, 19 m north) and the Belfry again.
  const ring = ringFromLonLat([
    [3.724972, 51.053686],
    [3.720558, 51.053854],
    [3.724972, 51.054686],
    [3.724972, 51.053686],
  ])
  assert.equal(ring.length, 3)
  assert.ok(near(ring[0]![0], 0) && near(ring[0]![1], 0))
  assert.ok(near(ring[1]![0], -308.9, 0.2), `x ${ring[1]![0]}`)
  assert.ok(near(ring[1]![1], -18.7, 0.2), `z ${ring[1]![1]}`)
  // 0.001 degrees of latitude north is about 111 m, and north is -z.
  assert.ok(near(ring[2]![1], -111.3, 0.5))
})

test("Polygon and MultiPolygon geometries convert; other geometries are skipped", () => {
  const poly = [
    [
      [3.72, 51.05],
      [3.721, 51.05],
      [3.721, 51.051],
      [3.72, 51.05],
    ],
  ]
  assert.equal(polygonsFromGeometry({ type: "Polygon", coordinates: poly }).length, 1)
  assert.equal(polygonsFromGeometry({ type: "MultiPolygon", coordinates: [poly, poly] }).length, 2)
  assert.deepEqual(polygonsFromGeometry({ type: "LineString", coordinates: poly[0] }), [])
  assert.deepEqual(polygonsFromGeometry(null), [])
})

test("rings are clipped to the area", () => {
  const rect: Rect = { minX: 5, minZ: -100, maxX: 100, maxZ: 100 }
  assert.ok(near(Math.abs(ringArea(clipRing(square(0, 0, 10), rect))), 50))
  assert.deepEqual(clipRing(square(-50, 0, 10), rect), [])
  assert.deepEqual(clipRing(square(10, 0, 10), rect), square(10, 0, 10))
})

test("simplifying drops points within the tolerance and keeps the corners", () => {
  // A 10 m square with a point every metre along each side.
  const dense: Ring = []
  for (let i = 0; i < 10; i++) dense.push([i, 0])
  for (let i = 0; i < 10; i++) dense.push([10, i])
  for (let i = 10; i > 0; i--) dense.push([i, 10])
  for (let i = 10; i > 0; i--) dense.push([0, i])
  const simple = simplifyRing(dense, 0.1)
  assert.equal(simple.length, 4)
  assert.ok(near(Math.abs(ringArea(simple)), 100))
  // A 1 m bump on one side survives a 0.4 m tolerance and goes at 2 m.
  const bumped: Ring = [[0, 0], [5, 0], [5.5, -1], [6, 0], [10, 0], [10, 10], [0, 10]]
  assert.equal(simplifyRing(bumped, 0.4).length, 7)
  assert.equal(simplifyRing(bumped, 2).length, 4)
})

test("a polygon with a hole triangulates to its area, every triangle facing up", () => {
  const polygon: Polygon = [square(0, 0, 10), square(3, 3, 4)]
  const { points, triangles } = triangulate(polygon)
  assert.equal(points.length, 8)
  assert.equal(triangles.length / 3, 8)
  let total = 0
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [points[triangles[t]!]!, points[triangles[t + 1]!]!, points[triangles[t + 2]!]!]
    // y of (b - a) x (c - a): positive means the face points up.
    const up = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1])
    assert.ok(up > 0, `triangle ${t / 3} faces down`)
    total += up / 2
  }
  assert.ok(near(total, 100 - 16))
  assert.ok(near(polygonArea(polygon), 84))
})

test("a reversed outline triangulates facing up too", () => {
  const { triangles } = triangulate([square(0, 0, 10).reverse()])
  assert.equal(triangles.length / 3, 2)
})

test("the water surface lies at the water level, facing up", () => {
  const geometry = surfaceGeometry([[square(0, 0, 10)], [square(20, 0, 10), square(23, 3, 4)]], WATER_LEVEL_M)
  const pos = geometry.getAttribute("position")
  const normal = geometry.getAttribute("normal")
  assert.equal(pos.count, 4 + 8)
  assert.equal(geometry.getIndex()!.count, 3 * (2 + 8))
  for (let i = 0; i < pos.count; i++) {
    assert.equal(pos.getY(i), WATER_LEVEL_M)
    assert.deepEqual([normal.getX(i), normal.getY(i), normal.getZ(i)], [0, 1, 0])
  }
})

test("quay walls line the water, not the seam between two water polygons or the area's border", () => {
  // Two water squares side by side: the shared side is no quay.
  assert.equal(quayEdges([[square(0, 0, 10)], [square(10, 0, 10)]], BIG).length, 6)
  // A river cut by the area's border has no wall along the border.
  const rect: Rect = { minX: -100, minZ: 0, maxX: 100, maxZ: 100 }
  assert.equal(quayEdges([[clipRing(square(0, -10, 20), rect)]], rect).length, 3)
})

test("a quay edge that is partly a seam gets a wall only along the bank", () => {
  // B borders the lower half of A's east side; the upper half is a bank.
  const a: Polygon = [square(0, 0, 20)]
  const b: Polygon = [[[20, 0], [30, 0], [30, 10], [20, 10]]]
  const east = quayEdges([a, b], BIG).filter(([p, q]) => p[0] === 20 && q[0] === 20)
  assert.equal(east.length, 1)
  const [from, to] = east[0]!
  assert.ok(near(Math.min(from[1], to[1]), 10, 0.5) && near(Math.max(from[1], to[1]), 20), `${from} -> ${to}`)
})

test("a bridge gets sides only where it crosses the water, reaching both banks", () => {
  const river: Polygon = [[[0, -100], [20, -100], [20, 100], [0, 100]]]
  const bridge: Polygon = [[[-10, -5], [30, -5], [30, 5], [-10, 5]]]
  const edges = bridgeEdges([bridge], [river], BIG)
  assert.equal(edges.length, 2)
  for (const [a, b] of edges) {
    assert.equal(a[1], b[1])
    const [lo, hi] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
    assert.ok(lo <= 0 && lo >= -1 && hi >= 20 && hi <= 21, `${lo} .. ${hi}`)
  }
})

test("a bridge edge with a dry middle still gets a side where it crosses the water", () => {
  // The edge runs from x = -5 to x = 100; the river is x = 0..20, so the middle is dry.
  const river: Polygon = [[[0, -100], [20, -100], [20, 100], [0, 100]]]
  const bridge: Polygon = [[[-5, -5], [100, -5], [100, 5], [-5, 5]]]
  const edges = bridgeEdges([bridge], [river], BIG)
  assert.equal(edges.length, 2)
  for (const [a, b] of edges) assert.ok(Math.min(a[0], b[0]) <= 0 && Math.max(a[0], b[0]) >= 20)
})

test("an edge splits into the runs where the test holds", () => {
  const wet = (p: XZ) => (p[0] > 2 && p[0] < 4) || p[0] > 8
  assert.deepEqual(edgeRuns([0, 0], [10, 0], wet), [
    [[2, 0], [4, 0]],
    [[8, 0], [10, 0]],
  ])
  assert.deepEqual(edgeRuns([0, 0], [10, 0], wet, true), [
    [[1.5, 0], [4.5, 0]],
    [[7.5, 0], [10, 0]],
  ])
  assert.deepEqual(edgeRuns([0, 0], [10, 0], () => false), [])
  assert.deepEqual(edgeRuns([0, 0], [0, 0], () => true), [])
})

test("rings round-trip through the fixture's flat encoding at 0.1 m", () => {
  const ring: Ring = [[1.234, -5.678], [10.05, 3], [-2, 7.96]]
  assert.deepEqual(encodeRing(ring), [1.2, -5.7, 10.1, 3, -2, 8])
  assert.deepEqual(decodeRing(encodeRing(ring)), [[1.2, -5.7], [10.1, 3], [-2, 8]])
})

test("a malformed fixture is an error", () => {
  assert.throws(() => parseGroundFile(null), /area/)
  assert.throws(() => parseGroundFile({ area: [0, 0, 1, 1], water: [[[0, 0, 1]]], roads: [], bridges: [] }), /x, z pairs/)
  assert.throws(() => parseGroundFile({ area: [0, 0, 1, 1], water: [], roads: {}, bridges: [] }), /roads/)
})

const FIXTURE = "public/fixtures/ground.json"

test("the fixture covers the whole area in under 300 KB", () => {
  assert.ok(statSync(FIXTURE).size < 300 * 1024)
  const data = parseGroundFile(JSON.parse(readFileSync(FIXTURE, "utf8")))
  const rect = areaRect()
  for (const key of ["minX", "minZ", "maxX", "maxZ"] as const) assert.ok(near(data.area[key], rect[key], 0.06), key)
  assert.ok(data.water.length >= 5, `${data.water.length} water polygons`)
  assert.ok(data.roads.length >= 500, `${data.roads.length} road polygons`)
  assert.ok(data.bridges.length >= 10, `${data.bridges.length} bridges`)
  for (const polygon of [...data.water, ...data.roads, ...data.bridges]) {
    for (const ring of polygon) {
      assert.ok(ring.length >= 3)
      for (const [x, z] of ring) {
        assert.ok(x >= rect.minX - 0.1 && x <= rect.maxX + 0.1 && z >= rect.minZ - 0.1 && z <= rect.maxZ + 0.1, `${x}, ${z}`)
      }
    }
  }
})

test("the fixture's water traces the Leie along the Graslei and the Schelde, with the Sint-Michielsbrug over it", () => {
  const data = parseGroundFile(JSON.parse(readFileSync(FIXTURE, "utf8")))
  const inAny = (p: XZ, list: Polygon[]) => list.some((polygon) => pointInPolygon(p, polygon))
  assert.ok(inAny([-300, -200], data.water), "the Leie off the Graslei")
  assert.ok(inAny([-310, -100], data.water), "the Leie between the Graslei and the Sint-Michielsbrug")
  assert.ok(inAny([250, 193], data.water), "the Nederschelde")
  assert.ok(inAny([-310, -19], data.water) && inAny([-310, -19], data.bridges), "the Sint-Michielsbrug over the Leie")
  // The Belfry and the Korenmarkt are dry land.
  assert.ok(!inAny([0, 0], data.water))
  assert.ok(!inAny([-210, -30], data.water))
})

// test/fixtures/ground.png is a real screenshot of the view from above
// (checks/ground.json's "view"), and test/recordings/ holds the Decisions API's
// answers for it, so this runs the whole check with no key and no network.
test("the recorded view from above passes its checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(process.execPath, ["scripts/check-visual.ts", "test/fixtures/ground.png", "checks/ground.json", "--replay"], {
    encoding: "utf8",
    env,
  })
  assert.equal(run.status, 0, run.stderr + run.stdout)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 3, run.stdout)
})
