// Download lower Manhattan's building footprints and roof heights from NYC Open Data
// (BUILDING, dataset 5zhs-2jue) and convert them to the scene's local metres.
//
//   node scripts/fetch-buildings.ts             # AREA -> data/buildings.json, plus the fixture
//   node scripts/fetch-buildings.ts --fixture   # only the fixture: FIXTURE_RADIUS_M around the venue
//
// data/ is not committed. The fixture in public/fixtures/ is small enough to commit,
// so tests and screenshots work offline.

import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, relative } from "node:path"
import { cwd } from "node:process"
import { parseArgs } from "node:util"
import { AREA, FIXTURE_RADIUS_M } from "../src/constants.ts"
import { toLatLon, toLocal, VENUE, type LatLon, type Local } from "../src/geo.ts"
import type { Building, BuildingsFile, Footprint, Ring } from "../src/layers/buildings.ts"

const DATASET = "https://data.cityofnewyork.us/resource/5zhs-2jue.json"
const SOURCE = "NYC Open Data, BUILDING (5zhs-2jue)"
const PAGE_SIZE = 5000
const FEET_M = 0.3048
// Footprints without a roof height still get a low block, not a hole in the city.
export const MIN_HEIGHT_M = 3
// Skybridges (2110) and cantilevered parts (1006) do not stand on the ground:
// extruded from street level they would wall off the street below them.
const SKIPPED_FEATURES = new Set(["2110", "1006"])

const DATA_PATH = fileURLToPath(new URL("../data/buildings.json", import.meta.url))
const FIXTURE_PATH = fileURLToPath(new URL("../public/fixtures/buildings.json", import.meta.url))

type Position = number[] // [lon, lat]
export type Geometry =
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] }

// One row of the Socrata API. The dataset calls the roof height `height_roof`, in feet
// above the ground.
export type Row = { the_geom?: Geometry; bin?: string; height_roof?: string; feature_code?: string }

// A decimetre is far finer than the footprints are accurate, and keeps the files small.
function round(n: number): number {
  return Math.round(n * 10) / 10
}

// A ring of [lon, lat] to a flat [x0, z0, x1, z1, ...] in metres, without the closing
// point and without points that round onto the one before.
export function convertRing(ring: Position[], origin: LatLon = VENUE): Ring {
  const out: Ring = []
  for (const [lon, lat] of ring) {
    const { x, z } = toLocal({ lat: lat!, lon: lon! }, origin)
    const rx = round(x)
    const rz = round(z)
    if (out.length >= 2 && out[out.length - 2] === rx && out[out.length - 1] === rz) continue
    out.push(rx, rz)
  }
  while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2
  return out
}

// Every polygon of a footprint, each as its outer ring followed by its holes. Rings
// that collapse to fewer than three points are dropped; a polygon goes with its outer ring.
export function convertFootprint(geometry: Geometry, origin: LatLon = VENUE): Footprint[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates
  const out: Footprint[] = []
  for (const [outer, ...holes] of polygons) {
    if (outer == null) continue
    const ring = convertRing(outer, origin)
    if (ring.length < 6) continue
    out.push([ring, ...holes.map((h) => convertRing(h, origin)).filter((h) => h.length >= 6)])
  }
  return out
}

export function heightMetres(feet: string | undefined): number {
  const n = Number(feet)
  return Number.isFinite(n) && n > 0 ? Math.max(MIN_HEIGHT_M, round(n * FEET_M)) : MIN_HEIGHT_M
}

export function toBuilding(row: Row, origin: LatLon = VENUE): Building | null {
  if (row.the_geom == null || row.bin == null || SKIPPED_FEATURES.has(row.feature_code ?? "")) return null
  const p = convertFootprint(row.the_geom, origin)
  return p.length === 0 ? null : { bin: row.bin, h: heightMetres(row.height_roof), p }
}

// The mean of a building's outer-ring points: close enough to its centre to decide
// which buildings are near the venue.
export function centre(building: Building): Local {
  let x = 0
  let z = 0
  let n = 0
  for (const [outer] of building.p) {
    for (let i = 0; i < outer!.length; i += 2) {
      x += outer![i]!
      z += outer![i + 1]!
      n++
    }
  }
  return { x: x / n, z: z / n }
}

export function withinRadius(buildings: Building[], radiusM: number): Building[] {
  return buildings.filter((b) => {
    const c = centre(b)
    return Math.hypot(c.x, c.z) <= radiusM
  })
}

type Box = { south: number; north: number; west: number; east: number }

// A box around the venue, with a margin, for downloading only the fixture's buildings.
function boxAround(radiusM: number): Box {
  const sw = toLatLon({ x: -radiusM, z: radiusM })
  const ne = toLatLon({ x: radiusM, z: -radiusM })
  return { south: sw.lat, north: ne.lat, west: sw.lon, east: ne.lon }
}

async function download(box: Box): Promise<Row[]> {
  const rows: Row[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL(DATASET)
    url.searchParams.set("$select", "the_geom,bin,height_roof,feature_code")
    url.searchParams.set("$where", `within_box(the_geom, ${box.north}, ${box.west}, ${box.south}, ${box.east})`)
    url.searchParams.set("$order", ":id")
    url.searchParams.set("$limit", String(PAGE_SIZE))
    url.searchParams.set("$offset", String(offset))
    const res = await fetch(url, { headers: { Accept: "application/json" } })
    if (!res.ok) throw new Error(`${url.host} answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const page = (await res.json()) as Row[]
    rows.push(...page)
    console.log(`  ${rows.length} footprints`)
    if (page.length < PAGE_SIZE) return rows
  }
}

function write(path: string, buildings: Building[]): void {
  const file: BuildingsFile = { source: SOURCE, origin: { lat: VENUE.lat, lon: VENUE.lon }, buildings }
  mkdirSync(dirname(path), { recursive: true })
  const json = JSON.stringify(file) + "\n"
  writeFileSync(path, json)
  console.log(`${relative(cwd(), path)}: ${buildings.length} buildings, ${Math.round(json.length / 1024)} KB`)
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { fixture: { type: "boolean", default: false } } })
  // The fixture's radius plus a margin, so footprints that cross the box edge come too.
  const box = values.fixture ? boxAround(FIXTURE_RADIUS_M + 100) : AREA
  console.log(`downloading ${SOURCE} for ${values.fixture ? "the fixture" : "AREA"}`)
  const buildings = (await download(box)).map((row) => toBuilding(row)).filter((b) => b != null)
  if (!values.fixture) write(DATA_PATH, buildings)
  write(FIXTURE_PATH, withinRadius(buildings, FIXTURE_RADIUS_M))
}
