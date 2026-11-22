import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { test } from "node:test"
import { Mesh, MeshBasicMaterial, Raycaster, Vector3 } from "three"
import {
  applyAffine,
  centroid,
  extractTiff,
  fitAffine,
  footprintToLocal,
  percentile,
  ringArea2,
  sampleFootprint,
  splitHeights,
  topOf,
  type Cell,
  type Raster,
} from "../scripts/fetch-buildings.ts"
import { FIXTURE_RADIUS_M } from "../src/constants.ts"
import { ORIGIN, toLatLon } from "../src/geo.ts"
import {
  buildChunks,
  buildHighlight,
  indexBuildings,
  parseBuildingSelection,
  pickBuilding,
  type BuildingRecord,
  type BuildingsFile,
} from "../src/layers/buildings.ts"
import { placeBySlug } from "../src/places.ts"
import { toLocal } from "../src/geo.ts"

// ---------------------------------------------------------------------------------
// Footprint conversion

// A GeoJSON ring (closed, [lon, lat]) through scene points given in metres.
function degrees(points: Array<[number, number]>): number[][] {
  const ring = points.map(([x, z]) => {
    const { lat, lon } = toLatLon({ x, z })
    return [lon, lat]
  })
  return [...ring, ring[0]!]
}

test("a footprint in degrees becomes a flat ring in metres, rounded to 0.1 m, without its closing point", () => {
  const [polygon] = footprintToLocal({
    type: "Polygon",
    coordinates: [degrees([[0, 0], [10.04, 0], [10.04, 20], [0, 20]])],
  })
  assert.deepEqual(polygon, [[0, 0, 10, 0, 10, 20, 0, 20]])
})

test("outer rings come out clockwise seen from above and holes the other way, whatever the input order", () => {
  const outerCcw = degrees([[0, 0], [0, 30], [30, 30], [30, 0]])
  const holeCw = degrees([[10, 10], [20, 10], [20, 20], [10, 20]])
  const [polygon] = footprintToLocal({ type: "Polygon", coordinates: [outerCcw, holeCw] })
  assert.equal(polygon!.length, 2)
  assert.ok(ringArea2(polygon![0]!) > 0, "outer ring is clockwise (positive)")
  assert.ok(ringArea2(polygon![1]!) < 0, "hole is counter-clockwise (negative)")
})

test("points that round onto their neighbour and degenerate parts are dropped", () => {
  const polygons = footprintToLocal({
    type: "MultiPolygon",
    coordinates: [
      [degrees([[0, 0], [0.01, 0.01], [5, 0], [5, 5], [0, 5]])],
      [degrees([[50, 50], [50.02, 50.01], [50.01, 50.02]])],
    ],
  })
  assert.equal(polygons.length, 1)
  assert.equal(polygons[0]![0]!.length, 8)
})

// ---------------------------------------------------------------------------------
// Height sampling on a tiny synthetic raster

// 6 x 6 cells of 1 m, top-left corner at (1000, 2006) in Lambert 72. Terrain is 5 m
// everywhere; a 4 x 4 m building stands on cells 1..4 with its roof at 5 + h.
function rasters(heights: (col: number, row: number) => number): { dsm: Raster; dtm: Raster } {
  const dsm = new Float32Array(36)
  const dtm = new Float32Array(36).fill(5)
  for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) dsm[row * 6 + col] = 5 + heights(col, row)
  const base = { x0: 1000, y0: 2006, width: 6, height: 6, size: 1 }
  return { dsm: { ...base, values: dsm }, dtm: { ...base, values: dtm } }
}

const square = {
  type: "Polygon" as const,
  coordinates: [[[1001, 2005], [1005, 2005], [1005, 2001], [1001, 2001], [1001, 2005]]],
}

test("sampling takes surface minus terrain at every cell centre inside the footprint", () => {
  const { dsm, dtm } = rasters((col, row) => (col >= 1 && col <= 4 && row >= 1 && row <= 4 ? 10 + col : 0))
  const cells = sampleFootprint(dsm, dtm, square)
  assert.equal(cells.length, 16)
  assert.ok(cells.every((c) => c.col >= 1 && c.col <= 4 && c.row >= 1 && c.row <= 4))
  assert.deepEqual([...new Set(cells.map((c) => c.h))].sort(), [11, 12, 13, 14])
  assert.equal(percentile(cells.map((c) => c.h), 90), 14)
})

test("cells without data are skipped, holes are outside, and a sliver still gets a height", () => {
  const { dsm, dtm } = rasters(() => 8)
  dsm.values[1 * 6 + 1] = -9999
  const withHole = {
    type: "Polygon" as const,
    coordinates: [square.coordinates[0]!, [[1002, 2004], [1002, 2003], [1003, 2003], [1003, 2004], [1002, 2004]]],
  }
  assert.equal(sampleFootprint(dsm, dtm, withHole).length, 14)
  const sliver = { type: "Polygon" as const, coordinates: [[[1002.1, 2004.9], [1002.3, 2004.9], [1002.2, 2004.7], [1002.1, 2004.9]]] }
  assert.deepEqual(sampleFootprint(dsm, dtm, sliver), [{ col: 2, row: 1, h: 8 }])
})

test("percentile interpolates between ranks", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3)
  assert.equal(percentile([0, 10], 90), 9)
  assert.ok(Number.isNaN(percentile([], 90)))
})

// ---------------------------------------------------------------------------------
// Towers

function grid(width: number, height: number, h: (col: number, row: number) => number): Cell[] {
  const cells: Cell[] = []
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) cells.push({ col, row, h: h(col, row) })
  return cells
}

test("a plain building gets one height, its 90th percentile", () => {
  const split = splitHeights(grid(10, 10, (c) => 10 + c * 0.2))
  assert.equal(split.towers.length, 0)
  assert.ok(Math.abs(split.body - 11.62) < 0.01)
})

test("a tower in a nave is split out, and a one-cell strip of trees is not a tower", () => {
  const split = splitHeights(
    grid(30, 20, (col, row) => {
      if (col >= 2 && col < 8 && row >= 2 && row < 8) return 60
      if (col === 20) return 45
      return 15
    }),
  )
  assert.equal(split.towers.length, 1)
  assert.equal(split.towers[0]!.cells.length, 36)
  assert.equal(split.towers[0]!.h, 60)
  assert.equal(split.towers[0]!.s, undefined)
  assert.ok(split.body >= 15 && split.body < 45, `body ${split.body}`)
})

test("a tower whose top cells rise far above the rest gets a spire", () => {
  const split = splitHeights(
    grid(30, 30, (col, row) => {
      const d = Math.max(Math.abs(col - 7), Math.abs(row - 7))
      if (d === 0) return 92
      if (d === 1) return 85
      if (d <= 5) return 60 + (5 - d) * 2
      return 20
    }),
  )
  assert.equal(split.towers.length, 1)
  const t = split.towers[0]!
  assert.ok(t.s != null && t.s > 80, `spire tip ${t.s}`)
  assert.ok(t.h < 70, `shaft ${t.h}`)
})

// ---------------------------------------------------------------------------------
// Lambert to scene placement

test("the affine fit recovers a known map", () => {
  const truth = [0.99, 0.02, -104000, 0.03, -1.01, 194000] as const
  const pairs = [[104000, 193800], [105000, 193900], [104500, 194500], [104200, 194100]].map(([X, Y]) => ({
    from: [X!, Y!] as [number, number],
    to: [truth[0] * X! + truth[1] * Y! + truth[2], truth[3] * X! + truth[4] * Y! + truth[5]] as [number, number],
  }))
  const fit = fitAffine(pairs)
  const [x, z] = applyAffine(fit, 104321, 193987)
  assert.ok(Math.abs(x - (truth[0] * 104321 + truth[1] * 193987 + truth[2])) < 1e-6)
  assert.ok(Math.abs(z - (truth[3] * 104321 + truth[4] * 193987 + truth[5])) < 1e-6)
})

// ---------------------------------------------------------------------------------
// The WCS answer

test("the GeoTIFF is cut out of a multipart/related answer", () => {
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x0a, 0x0d, 0x0a, 0xff])
  const body = Buffer.concat([
    Buffer.from('--wcs\nContent-Type: text/xml\nContent-ID: GML-Part\n\n<gml/>\n--wcs\nContent-Type: image/tiff\nContent-ID: 1.tif\n\n'),
    tiff,
    Buffer.from("\n--wcs--\n"),
  ])
  const out = extractTiff(new Uint8Array(body), 'multipart/related; boundary="wcs";start="GML-Part";type="text/xml"')
  assert.deepEqual(Buffer.from(out), tiff)
  assert.deepEqual(extractTiff(new Uint8Array(tiff), "image/tiff"), new Uint8Array(tiff))
})

// ---------------------------------------------------------------------------------
// Selection: OIDN lookup and picking

const box = (id: number, x: number, z: number, h: number): BuildingRecord => ({
  id,
  h,
  p: [[[x, z, x + 10, z, x + 10, z + 10, x, z + 10]]],
})

test("a selection id parses to its OIDN, and only building ids do", () => {
  assert.equal(parseBuildingSelection("bldg:1362089"), 1362089)
  assert.equal(parseBuildingSelection("garage:vrijdagmarkt"), null)
  assert.equal(parseBuildingSelection("bldg:12a"), null)
  assert.equal(parseBuildingSelection("bldg:"), null)
  assert.equal(parseBuildingSelection(null), null)
  const index = indexBuildings([box(7, 0, 0, 5), box(42, 20, 0, 9)])
  assert.equal(index.get(42), 1)
  assert.equal(index.get(8), undefined)
})

test("a ray answers the OIDN of the building it hits first", () => {
  const buildings = [box(7, 0, 0, 5), box(42, 20, 0, 30), box(9, 600, 600, 12)]
  const meshes = buildChunks(buildings, 0).map(({ geometry, owner }) => {
    const mesh = new Mesh(geometry, new MeshBasicMaterial())
    mesh.userData = { owner }
    return mesh
  })
  assert.equal(meshes.length, 2, "buildings 600 m apart land in different chunks")
  const ray = new Raycaster()
  const down = new Vector3(0, -1, 0)
  ray.set(new Vector3(25, 100, 5), down)
  assert.equal(pickBuilding(ray, meshes, buildings), "bldg:42")
  ray.set(new Vector3(5, 100, 5), down)
  assert.equal(pickBuilding(ray, meshes, buildings), "bldg:7")
  ray.set(new Vector3(605, 100, 605), down)
  assert.equal(pickBuilding(ray, meshes, buildings), "bldg:9")
  // From the side, the nearer wall wins.
  ray.set(new Vector3(-50, 3, 5), new Vector3(1, 0, 0))
  assert.equal(pickBuilding(ray, meshes, buildings), "bldg:7")
  ray.set(new Vector3(15, 100, 5), down)
  assert.equal(pickBuilding(ray, meshes, buildings), null)
})

test("walls and roofs face outward and up", () => {
  const [chunk] = buildChunks([box(1, 0, 0, 10)], 0)
  const normals = chunk!.geometry.getAttribute("normal")
  const positions = chunk!.geometry.getAttribute("position")
  for (let v = 0; v < positions.count; v++) {
    const [x, y, z] = [positions.getX(v), positions.getY(v), positions.getZ(v)]
    const [nx, ny, nz] = [normals.getX(v), normals.getY(v), normals.getZ(v)]
    if (ny === 1) assert.equal(y, 10, "a roof vertex")
    else assert.ok((x - 5) * nx + (z - 5) * nz > 0, `wall normal points out at ${x},${z}`)
  }
  // The roof's triangles wind counter-clockwise seen from above, so they face up.
  const index = (t: number, k: number) => new Vector3().fromBufferAttribute(positions, t * 3 + k)
  for (let t = 0; t < chunk!.owner.length; t++) {
    const n = new Vector3().subVectors(index(t, 1), index(t, 0)).cross(new Vector3().subVectors(index(t, 2), index(t, 0)))
    const declared = new Vector3().fromBufferAttribute(normals, t * 3)
    assert.ok(n.dot(declared) > 0, `triangle ${t} winds the way its normal points`)
  }
  assert.ok(buildHighlight(box(1, 0, 0, 10), 0).getAttribute("position").count > 0)
})

// ---------------------------------------------------------------------------------
// The committed fixture

const fixturePath = "public/fixtures/buildings.json"
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as BuildingsFile

function inside(x: number, z: number, ring: number[]): boolean {
  let c = false
  for (let i = 0, j = ring.length / 2 - 1; i < ring.length / 2; j = i++) {
    const [xi, zi, xj, zj] = [ring[2 * i]!, ring[2 * i + 1]!, ring[2 * j]!, ring[2 * j + 1]!]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}

const buildingAt = (slug: string): BuildingRecord | undefined => {
  const { x, z } = toLocal(placeBySlug(slug)!)
  return fixture.buildings.find((b) => b.p.some((polygon) => inside(x, z, polygon[0]!)))
}

test("the fixture holds at least 300 buildings within FIXTURE_RADIUS_M of the Belfry, in under 300 KB", () => {
  assert.ok(fixture.buildings.length >= 300, `${fixture.buildings.length} buildings`)
  assert.ok(statSync(fixturePath).size < 300 * 1024)
  for (const b of fixture.buildings) {
    const c = centroid(b.p)
    assert.ok(Math.hypot(c.x, c.z) <= FIXTURE_RADIUS_M, `bldg:${b.id} lies outside the fixture radius`)
    assert.ok(b.h > 0 && b.h < 120, `bldg:${b.id} is ${b.h} m tall`)
  }
  assert.equal(new Set(fixture.buildings.map((b) => b.id)).size, fixture.buildings.length, "OIDNs are unique")
  assert.ok(new Set(fixture.buildings.map((b) => Math.round(b.h / 5))).size >= 6, "heights vary")
})

test("the Belfry's footprint comes out 80 to 100 m tall", () => {
  const belfry = buildingAt("belfort")
  assert.ok(belfry != null, "a footprint covers the Belfry")
  const top = topOf(belfry)
  assert.ok(top >= 80 && top <= 100, `Belfry is ${top} m`)
  assert.ok(belfry.h < 40, `the Cloth Hall stays low (${belfry.h} m), the tower is a part of its own`)
})

test("Sint-Niklaas and Sint-Baafs stand as towers above their naves", () => {
  for (const slug of ["sint-niklaas", "sint-baafs"]) {
    const church = buildingAt(slug)
    assert.ok(church != null, `a footprint covers ${slug}`)
    const tower = topOf(church)
    assert.ok(tower >= 50, `${slug} tower is ${tower} m`)
    assert.ok(tower > church.h * 1.5, `${slug} tower (${tower} m) rises well above its nave (${church.h} m)`)
  }
})

test("the origin is the Belfry, as the fixture assumes", () => {
  assert.deepEqual(toLocal(ORIGIN), { x: 0, z: -0 })
})

// ---------------------------------------------------------------------------------
// The visual check, replayed: test/fixtures/buildings.png is a real screenshot of the
// check file's view, and test/recordings/ holds the Decisions API's answers for it.

test("the recorded buildings screenshot passes its checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(
    process.execPath,
    ["scripts/check-visual.ts", "test/fixtures/buildings.png", "checks/buildings.json", "--replay"],
    { encoding: "utf8", env },
  )
  assert.equal(run.status, 0, run.stderr + run.stdout)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 3, run.stdout)
})
