import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { test } from "node:test"
import {
  CAR_FREE_COLOUR,
  PEDESTRIAN_COLOUR,
  SECTOR_COLOURS,
  SECTOR_NAMES,
  SECTORS,
  areaRect,
  classifySectorFeatures,
  clipPolygon,
  clipRing,
  colourSectors,
  decodePoints,
  encodePoints,
  findNeighbours,
  knipKind,
  knipPosts,
  labelPoint,
  linesFromGeometry,
  onRectBorder,
  parseCirculationFile,
  pointInPolygon,
  polygonArea,
  polygonsFromGeometry,
  postScale,
  ringArea,
  sectorBySlug,
  simplifyRing,
  slugify,
  zoneAt,
  zoneLabels,
  type Polygon,
  type Rect,
  type Ring,
  type SourceFeature,
  type XZ,
} from "../src/layers/circulation.ts"

const square = (x: number, z: number, size: number): Ring => [
  [x, z],
  [x + size, z],
  [x + size, z + size],
  [x, z + size],
]
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps
const fixture = () => parseCirculationFile(JSON.parse(readFileSync("public/fixtures/circulation.json", "utf8")))

// ---------------------------------------------------------------------------------
// Slugs and the sector names the city state reads.

test("slugs are lower case ASCII words joined by '-'", () => {
  assert.equal(slugify("Portus Ganda"), "portus-ganda")
  assert.equal(slugify("Sint-Michiels"), "sint-michiels")
  assert.equal(slugify("Brugse Poort"), "brugse-poort")
  assert.equal(slugify("  Kuip_VGG_Centrum "), "kuip-vgg-centrum")
  assert.equal(slugify("Sint-Pietersplein (Zuid)"), "sint-pietersplein-zuid")
  assert.equal(slugify("Ève Café"), "eve-cafe")
  assert.equal(slugify("---"), "")
})

test("the exported sectors are the plan's six sectors and the car-free Kuip, with unique slugs", () => {
  assert.deepEqual(
    [...SECTOR_NAMES].sort(),
    ["Brugse Poort", "Coupure", "Krook", "Kuip", "Portus Ganda", "Rabot", "Tolhuis"],
  )
  for (const sector of SECTORS) assert.equal(sector.slug, slugify(sector.name), sector.name)
  assert.equal(new Set(SECTORS.map((s) => s.slug)).size, SECTORS.length)
  assert.deepEqual(
    SECTORS.filter((s) => s.kind === "car-free").map((s) => s.slug),
    ["kuip"],
  )
  assert.equal(sectorBySlug("portus-ganda")?.name, "Portus Ganda")
  assert.equal(sectorBySlug("sector-zuid"), null)
})

test("the sector names import without a browser (no DOM at import time)", () => {
  const code =
    'const m = await import("./src/layers/circulation.ts"); ' +
    'if (typeof document !== "undefined") throw new Error("document exists"); ' +
    "console.log(JSON.stringify(m.SECTOR_NAMES))"
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout), [...SECTOR_NAMES])
})

// ---------------------------------------------------------------------------------
// Reading the source data.

const feature = (properties: Record<string, unknown>): SourceFeature => ({ geometry: null, properties })

test("records become sectors, car-free pieces and pedestrian streets of their area", () => {
  const { zones, skipped } = classifySectorFeatures([
    feature({ naam: "Coupure", zone: "Sector Coupure" }),
    feature({ naam: null, zone: "Sector Krook" }),
    feature({ naam: "Kuip_VGG_Patershol", zone: "Autovrij Nieuw", autovrijgebied_codedvalue: "AV10" }),
    feature({ naam: "Kuip_VGG_Centrum", zone: "Voetgangersstraat (zomer)", autovrijgebied_codedvalue: "AV10" }),
    // No name: joins the area that shares its code.
    feature({ naam: null, zone: null, autovrijgebied_codedvalue: "AV10" }),
    // A car-free street of its own, elsewhere in the city.
    feature({ naam: "Overpoortstraat", zone: "Autovrij Nieuw", autovrijgebied_codedvalue: "AV50" }),
    // Neither a name nor a code: nothing to attach it to.
    feature({ naam: null, zone: null }),
    { geometry: null, properties: null },
  ])
  assert.deepEqual(
    zones.map((z) => [z.name, z.kind]),
    [
      ["Coupure", "sector"],
      ["Krook", "sector"],
      ["Kuip", "car-free"],
      ["Kuip", "pedestrian"],
      ["Kuip", "car-free"],
      ["Overpoortstraat", "car-free"],
    ],
  )
  assert.equal(skipped, 2)
})

test("knip types map to posts, camera and median", () => {
  assert.equal(knipKind("Knip palen"), "posts")
  assert.equal(knipKind("Knip camera controle"), "camera")
  assert.equal(knipKind("Knip middenberm"), "median")
  assert.equal(knipKind(undefined), "posts")
})

test("GeoJSON polygons and lines become metres from the Belfry", () => {
  // The Belfry and points 0.001° east and north of it.
  const rings = [
    [
      [3.724972, 51.053686],
      [3.725972, 51.053686],
      [3.725972, 51.054686],
      [3.724972, 51.053686],
    ],
  ]
  const [polygon] = polygonsFromGeometry({ type: "Polygon", coordinates: rings })
  assert.equal(polygon?.[0]?.length, 3, "the closing point is dropped")
  const [x, z] = polygon![0]![2]!
  assert.ok(near(x, 70.0, 0.5), `x ${x}`)
  assert.ok(near(z, -111.3, 0.5), `z ${z}`)
  assert.equal(polygonsFromGeometry({ type: "MultiPolygon", coordinates: [rings, rings] }).length, 2)
  assert.deepEqual(polygonsFromGeometry({ type: "Point", coordinates: [3.7, 51] }), [])
  const [line] = linesFromGeometry({ type: "LineString", coordinates: [[3.724972, 51.053686], [3.725972, 51.053686]] })
  assert.ok(near(line![0]![0], 0) && near(line![1]![0], 70.0, 0.5))
})

// ---------------------------------------------------------------------------------
// Plane geometry.

test("clipping keeps the part inside the area and marks its cut edges", () => {
  const rect: Rect = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 }
  const clipped = clipRing(square(-5, -5, 10), rect)
  assert.ok(near(Math.abs(ringArea(clipped)), 25))
  assert.ok(clipped.every(([x, z]) => x >= 0 && x <= 10 && z >= 0 && z <= 10))
  assert.equal(clipPolygon([square(20, 20, 5)], rect), null, "a polygon outside is dropped")
  // A hole survives the clip and still counts.
  const withHole = clipPolygon([square(-5, -5, 20), square(2, 2, 2)], rect)!
  assert.ok(near(polygonArea(withHole), 96))
  assert.equal(onRectBorder([0, 2], [0, 8], rect), true)
  assert.equal(onRectBorder([0, 2], [5, 8], rect), false)
})

test("simplifying drops points on straight runs and keeps corners", () => {
  const ring: Ring = [[0, 0], [5, 0.05], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]]
  const simple = simplifyRing(ring, 0.5)
  assert.equal(simple.length, 4)
  assert.ok(near(Math.abs(ringArea(simple)), 100))
})

test("points in holes are outside", () => {
  const polygon: Polygon = [square(0, 0, 10), square(4, 4, 2)]
  assert.equal(pointInPolygon([1, 1], polygon), true)
  assert.equal(pointInPolygon([5, 5], polygon), false)
  assert.equal(pointInPolygon([11, 5], polygon), false)
})

test("fixture rings round-trip at 0.1 m", () => {
  const points: XZ[] = [[1.234, -5.678], [100.06, 0]]
  assert.deepEqual(decodePoints(encodePoints(points)), [[1.2, -5.7], [100.1, 0]])
})

test("a label sits well inside a concave zone, not at its empty centre", () => {
  // An L shape: the bounding box's centre (5, 5) lies outside it.
  const l: Polygon = [[[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]]]
  const at = labelPoint(l)
  assert.equal(pointInPolygon(at, l), true)
  assert.ok(Math.min(at[0], at[1]) > 0.8, `too close to an edge: ${at}`)
})

// ---------------------------------------------------------------------------------
// Colours: no two neighbours share one, and the car-free area has its own.

// A centre ringed by five sectors, each touching the next: a map like the plan's.
function ringOfSectors(): Array<{ slug: string; polygons: Polygon[] }> {
  const wedge = (i: number): Polygon => {
    const a0 = (i * 2 * Math.PI) / 5
    const a1 = ((i + 1) * 2 * Math.PI) / 5
    const arc = (r: number, a: number): XZ => [r * Math.cos(a), r * Math.sin(a)]
    return [[arc(100, a0), arc(500, a0), arc(500, (a0 + a1) / 2), arc(500, a1), arc(100, a1)]]
  }
  return ["a", "b", "c", "d", "e"].map((slug, i) => ({ slug, polygons: [wedge(i)] }))
}

test("neighbours are the zones that share a border", () => {
  const n = findNeighbours(ringOfSectors(), 1)
  assert.deepEqual([...n.get("a")!].sort(), ["b", "e"])
  assert.deepEqual([...n.get("c")!].sort(), ["b", "d"])
})

test("no two neighbouring sectors share a colour, and each gets its own when the palette allows", () => {
  const zones = ringOfSectors()
  const n = findNeighbours(zones, 1)
  const colour = colourSectors(
    zones.map((z) => z.slug),
    n,
  )
  for (const [slug, others] of n) for (const other of others) assert.notEqual(colour.get(slug), colour.get(other), `${slug} and ${other}`)
  assert.equal(new Set(colour.values()).size, 5)
  // An odd ring needs three colours: with three, it still works.
  const three = colourSectors(
    zones.map((z) => z.slug),
    n,
    3,
  )
  for (const [slug, others] of n) for (const other of others) assert.notEqual(three.get(slug), three.get(other))
  // A sector touching more sectors than there are colours is an error, not a clash.
  const star = new Map([["hub", new Set(["x", "y"])], ["x", new Set(["hub", "y"])], ["y", new Set(["hub", "x"])]])
  assert.throws(() => colourSectors(["hub", "x", "y"], star, 2), /no colour left/)
})

test("the car-free colours are not in the sector palette", () => {
  assert.equal(new Set(SECTOR_COLOURS).size, SECTOR_COLOURS.length)
  assert.ok(!SECTOR_COLOURS.includes(CAR_FREE_COLOUR))
  assert.ok(!SECTOR_COLOURS.includes(PEDESTRIAN_COLOUR))
})

// ---------------------------------------------------------------------------------
// Knips.

test("a knip is a row of posts along its line, ends included", () => {
  const posts = knipPosts([[0, 0], [10, 0]])
  assert.equal(posts.length, 5)
  assert.deepEqual(posts[0], [0, 0])
  assert.deepEqual(posts[4], [10, 0])
  assert.equal(knipPosts([[0, 0], [1, 0]]).length, 2, "at least the two ends")
  assert.equal(knipPosts([[0, 0], [100, 0], [100, 100]]).length, 6, "at most six")
  assert.deepEqual(knipPosts([[0, 0], [0, 5], [5, 5]])[3], [2.5, 5], "spaced along a bent line")
  assert.deepEqual(knipPosts([[2, 2]]), [[2, 2]])
})

test("posts keep their size at street level and grow when seen from high up", () => {
  assert.equal(postScale(2), 1)
  assert.ok(postScale(420) > 4 && postScale(420) < 6)
  assert.ok(postScale(2200) > 20, "about 10 m wide from 2.2 km up")
  assert.equal(postScale(100_000), 28)
})

// ---------------------------------------------------------------------------------
// The committed fixture.

test("the fixture covers the whole area: the Kuip in the middle, a sector on every side", () => {
  const bytes = statSync("public/fixtures/circulation.json").size
  assert.ok(bytes < 300 * 1024, `${bytes} bytes`)
  const data = fixture()
  const rect = areaRect()
  assert.deepEqual(data.area, rect)
  assert.equal(zoneAt(data, [0, 0]), "kuip", "the Belfry is car-free")
  assert.equal(zoneAt(data, [-200, -20]), "kuip", "the Korenmarkt is car-free")
  assert.equal(zoneAt(data, [rect.minX + 30, 0]), "coupure")
  assert.equal(zoneAt(data, [0, rect.minZ + 30]), "tolhuis")
  assert.equal(zoneAt(data, [rect.maxX - 30, 0]), "portus-ganda")
  assert.equal(zoneAt(data, [0, rect.maxZ - 30]), "krook")
  // Every slug drawn is one the city state knows, so `sector:<slug>` always resolves.
  for (const zone of data.zones) assert.ok(sectorBySlug(zone.slug) != null, zone.slug)
  // No gaps: a grid over the area always lands in a zone.
  for (let x = rect.minX + 5; x < rect.maxX; x += 70) {
    for (let z = rect.minZ + 5; z < rect.maxZ; z += 70) assert.ok(zoneAt(data, [x, z]) != null, `no zone at ${x}, ${z}`)
  }
})

test("the fixture's neighbouring sectors get different colours", () => {
  const data = fixture()
  const sectors = data.zones.filter((z) => z.kind === "sector")
  const slugs = [...new Set(sectors.map((z) => z.slug))]
  assert.deepEqual([...slugs].sort(), ["coupure", "krook", "portus-ganda", "tolhuis"])
  const n = findNeighbours(sectors, 6, data.area)
  // Around the Kuip, each sector touches the two next to it.
  assert.deepEqual([...n.get("tolhuis")!].sort(), ["coupure", "portus-ganda"])
  assert.deepEqual([...n.get("krook")!].sort(), ["coupure", "portus-ganda"])
  const colour = colourSectors(slugs, n)
  for (const [slug, others] of n) for (const other of others) assert.notEqual(colour.get(slug), colour.get(other), `${slug} and ${other}`)
})

test("the fixture's knips lie inside the area, and each zone has one label inside it", () => {
  const data = fixture()
  const rect = areaRect()
  assert.ok(data.knips.length >= 30, `${data.knips.length} knips`)
  for (const knip of data.knips) {
    for (const [x, z] of knipPosts(knip.line)) assert.ok(x >= rect.minX - 50 && x <= rect.maxX + 50 && z >= rect.minZ - 50 && z <= rect.maxZ + 50)
  }
  const labels = zoneLabels(data)
  assert.deepEqual(labels.map((l) => l.slug).sort(), ["coupure", "krook", "kuip", "portus-ganda", "tolhuis"])
  for (const label of labels) assert.equal(zoneAt(data, label.at), label.slug, `${label.slug} label at ${label.at}`)
})

test("a malformed fixture is an error, not an empty layer", () => {
  assert.throws(() => parseCirculationFile({ zones: [], knips: [] }), /area/)
  assert.throws(() => parseCirculationFile({ area: [0, 0, 1, 1], zones: [{ name: "X", kind: "road", polygons: [] }], knips: [] }), /kind/)
  assert.throws(() => parseCirculationFile({ area: [0, 0, 1, 1], zones: [{ name: "X", kind: "sector", polygons: [[[0, 0, 1]]] }], knips: [] }), /flat/)
  assert.throws(() => parseCirculationFile({ area: [0, 0, 1, 1], zones: [], knips: [{ kind: "posts", line: [] }] }), /knip 0/)
})

// ---------------------------------------------------------------------------------
// The visual check, replayed: test/fixtures/circulation.png is a real screenshot from
// above (checks/circulation.json's "view") and test/recordings/ holds the Decisions
// API's real answers for it, so this runs with no key and no network.

test("the recorded top view passes its visual checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(
    process.execPath,
    ["scripts/check-visual.ts", "test/fixtures/circulation.png", "checks/circulation.json", "--replay"],
    { encoding: "utf8", env },
  )
  assert.equal(run.status, 0, run.stderr + run.stdout)
  const checks = (JSON.parse(readFileSync("checks/circulation.json", "utf8")) as { checks: unknown[] }).checks
  assert.equal(run.stdout.match(/^PASS /gm)?.length, checks.length, run.stdout)
})
