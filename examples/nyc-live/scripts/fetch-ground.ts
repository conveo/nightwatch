// Download the ground for AREA from NYC Open Data and convert it to local metres.
//
//   node scripts/fetch-ground.ts             # data/ground.json, at 0.1 m
//   node scripts/fetch-ground.ts --fixture   # public/fixtures/ground.json, at 1 m
//   node scripts/fetch-ground.ts --refresh   # download again instead of reusing data/raw/
//
// Sources (Socrata API, no key needed):
//   Borough Boundaries, water areas excluded (gthc-hcne): the land, already clipped to
//   the shoreline, so whatever is not land is water.
//   Centerline (inkn-q76z): the street centrelines; `rw_type` says what kind of road.
//
// The land is clipped to AREA plus GROUND_MARGIN_M, so the coast does not stop at the
// edge of the drawn area; the streets are clipped to the same box. Both files cover
// that whole box, unlike the other fixtures: the view from above needs both rivers.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { AREA } from "../src/constants.ts"
import { toLatLon, toLocal, type Local } from "../src/geo.ts"
import type { GroundBox, GroundData } from "../src/layers/ground.ts"

export const GROUND_MARGIN_M = 1000

const BOROUGHS_URL = "https://data.cityofnewyork.us/resource/gthc-hcne.geojson"
const CENTERLINE_URL = "https://data.cityofnewyork.us/resource/inkn-q76z.geojson"

// CSCL road types drawn as streets: street, highway, bridge, ramp, alley. Left out:
// tunnels, paths, step streets, driveways, ferry routes and non-physical segments.
export const STREET_TYPES: ReadonlySet<number> = new Set([1, 2, 3, 9, 10])

type Position = [number, number] // [lon, lat], as GeoJSON has it
type Geometry =
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] }
  | { type: "LineString"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] }
export type FeatureCollection = {
  type: "FeatureCollection"
  features: { type: "Feature"; geometry: Geometry | null; properties: Record<string, unknown> }[]
}

// AREA grown by `marginM` on every side, in local metres. The projection is
// equirectangular, so a lat/lon box stays an axis-aligned box.
export function groundBox(marginM = GROUND_MARGIN_M): GroundBox {
  const nw = toLocal({ lat: AREA.north, lon: AREA.west })
  const se = toLocal({ lat: AREA.south, lon: AREA.east })
  return { minX: nw.x - marginM, maxX: se.x + marginM, minZ: nw.z - marginM, maxZ: se.z + marginM }
}

export function project(positions: Position[]): Local[] {
  return positions.map(([lon, lat]) => toLocal({ lat, lon }))
}

// Sutherland-Hodgman against each side of the box. A concave ring that leaves and
// re-enters the box comes back joined along the box edge, which still fills right.
export function clipRing(ring: Local[], box: GroundBox): Local[] {
  const sides: { inside(p: Local): boolean; cut(a: Local, b: Local): Local }[] = [
    { inside: (p) => p.x >= box.minX, cut: (a, b) => atX(a, b, box.minX) },
    { inside: (p) => p.x <= box.maxX, cut: (a, b) => atX(a, b, box.maxX) },
    { inside: (p) => p.z >= box.minZ, cut: (a, b) => atZ(a, b, box.minZ) },
    { inside: (p) => p.z <= box.maxZ, cut: (a, b) => atZ(a, b, box.maxZ) },
  ]
  let out = openRing(ring)
  for (const side of sides) {
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!
      const prev = input[(i + input.length - 1) % input.length]!
      if (side.inside(cur)) {
        if (!side.inside(prev)) out.push(side.cut(prev, cur))
        out.push(cur)
      } else if (side.inside(prev)) {
        out.push(side.cut(prev, cur))
      }
    }
    if (out.length === 0) break
  }
  return out
}

function atX(a: Local, b: Local, x: number): Local {
  return { x, z: a.z + ((b.z - a.z) * (x - a.x)) / (b.x - a.x) }
}

function atZ(a: Local, b: Local, z: number): Local {
  return { x: a.x + ((b.x - a.x) * (z - a.z)) / (b.z - a.z), z }
}

// GeoJSON rings repeat their first point at the end; the clipper wants it once.
function openRing(ring: Local[]): Local[] {
  const first = ring[0]
  const last = ring[ring.length - 1]
  return first != null && last != null && ring.length > 1 && first.x === last.x && first.z === last.z
    ? ring.slice(0, -1)
    : ring
}

// Liang-Barsky per segment. A line that leaves the box and comes back becomes two lines.
export function clipLine(line: Local[], box: GroundBox): Local[][] {
  const pieces: Local[][] = []
  let current: Local[] = []
  for (let i = 1; i < line.length; i++) {
    const seg = clipSegment(line[i - 1]!, line[i]!, box)
    if (seg == null) {
      if (current.length > 1) pieces.push(current)
      current = []
      continue
    }
    const [a, b] = seg
    const tail = current[current.length - 1]
    if (tail == null || tail.x !== a.x || tail.z !== a.z) {
      if (current.length > 1) pieces.push(current)
      current = [a]
    }
    current.push(b)
  }
  if (current.length > 1) pieces.push(current)
  return pieces
}

function clipSegment(a: Local, b: Local, box: GroundBox): [Local, Local] | null {
  const dx = b.x - a.x
  const dz = b.z - a.z
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [
    [-dx, a.x - box.minX],
    [dx, box.maxX - a.x],
    [-dz, a.z - box.minZ],
    [dz, box.maxZ - a.z],
  ] as const) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return null
  }
  const at = (t: number): Local => (t === 0 ? a : t === 1 ? b : { x: a.x + dx * t, z: a.z + dz * t })
  return [at(t0), at(t1)]
}

// Douglas-Peucker: drop points closer than `tolerance` metres to the simplified line.
export function simplify(points: Local[], tolerance: number): Local[] {
  if (points.length < 3 || tolerance <= 0) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    let worst = -1
    let worstDist = tolerance
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(points[i]!, points[first]!, points[last]!)
      if (d > worstDist) {
        worst = i
        worstDist = d
      }
    }
    if (worst !== -1) {
      keep[worst] = 1
      stack.push([first, worst], [worst, last])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

// A closed ring has no natural endpoints, so it is split at its first point and the
// point farthest from it, and each half is simplified as a line.
function simplifyRing(ring: Local[], tolerance: number): Local[] {
  if (ring.length < 4) return ring
  const start = ring[0]!
  let far = 1
  for (let i = 2; i < ring.length; i++) {
    if (Math.hypot(ring[i]!.x - start.x, ring[i]!.z - start.z) > Math.hypot(ring[far]!.x - start.x, ring[far]!.z - start.z)) far = i
  }
  const a = simplify(ring.slice(0, far + 1), tolerance)
  const b = simplify([...ring.slice(far), start], tolerance)
  return [...a, ...b.slice(1, -1)]
}

function distanceToSegment(p: Local, a: Local, b: Local): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz))
}

// Signed area by the shoelace formula, in square metres.
export function ringArea(ring: Local[]): number {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!
    const b = ring[(i + 1) % ring.length]!
    sum += a.x * b.z - b.x * a.z
  }
  return sum / 2
}

// Round to `step` metres and flatten to [x0, z0, x1, z1, ...], dropping points that
// rounding made identical to the one before.
export function flatten(points: Local[], step: number): number[] {
  const out: number[] = []
  for (const p of points) {
    const x = roundTo(p.x, step)
    const z = roundTo(p.z, step)
    if (out.length >= 2 && out[out.length - 2] === x && out[out.length - 1] === z) continue
    out.push(x, z)
  }
  return out
}

function roundTo(n: number, step: number): number {
  // Rounding to a decimal step through its inverse avoids 0.30000000000000004.
  const inv = Math.round(1 / step)
  const r = Math.round(n * inv) / inv
  return Object.is(r, -0) ? 0 : r
}

export type ConvertOptions = {
  box: GroundBox
  // Metres: points are rounded to this step, and lines simplified by the same amount.
  step: number
  // Land rings smaller than this (square metres) are dropped: slivers left by clipping
  // and specks such as small piers. Those touch their neighbours, and touching rings
  // make the water, which has every land polygon as a hole, triangulate over the land.
  minRingArea?: number
}

export function toGroundData(boroughs: FeatureCollection, centerline: FeatureCollection, opts: ConvertOptions): GroundData {
  const { box, step } = opts
  const minRingArea = opts.minRingArea ?? 2000
  const land: number[][][] = []
  for (const feature of boroughs.features) {
    const g = feature.geometry
    const polygons = g?.type === "Polygon" ? [g.coordinates] : g?.type === "MultiPolygon" ? g.coordinates : []
    for (const polygon of polygons) {
      const rings: number[][] = []
      for (const [i, raw] of polygon.entries()) {
        const ring = simplifyRing(clipRing(project(raw), box), step)
        if (ring.length < 3 || Math.abs(ringArea(ring)) < minRingArea) {
          if (i === 0) break // no outer ring left, so its holes go too
          continue
        }
        const flat = flatten(ring, step)
        if (flat.length >= 6) rings.push(flat)
        else if (i === 0) break
      }
      if (rings.length > 0) land.push(rings)
    }
  }
  const streets: number[][] = []
  for (const feature of centerline.features) {
    if (!STREET_TYPES.has(Number(feature.properties.rw_type))) continue
    const g = feature.geometry
    const lines = g?.type === "LineString" ? [g.coordinates] : g?.type === "MultiLineString" ? g.coordinates : []
    for (const line of lines) {
      for (const piece of clipLine(project(line), box)) {
        const flat = flatten(simplify(piece, step), step)
        if (flat.length >= 4) streets.push(flat)
      }
    }
  }
  return {
    source: "NYC Open Data: Borough Boundaries (gthc-hcne), Centerline (inkn-q76z)",
    box,
    land,
    streets,
  }
}

async function download(url: string, params: Record<string, string>, cache: string, refresh: boolean): Promise<FeatureCollection> {
  if (!refresh && existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as FeatureCollection
  const full = `${url}?${new URLSearchParams(params)}`
  const res = await fetch(full)
  if (!res.ok) throw new Error(`${full}: HTTP ${res.status}`)
  const text = await res.text()
  mkdirSync(dirname(cache), { recursive: true })
  writeFileSync(cache, text)
  return JSON.parse(text) as FeatureCollection
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      fixture: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
      out: { type: "string" },
    },
  })
  const box = groundBox()
  // within_box only matches geometries wholly inside the box, which no borough is, so
  // ask for everything that touches it.
  const nw = toLatLon({ x: box.minX, z: box.minZ })
  const se = toLatLon({ x: box.maxX, z: box.maxZ })
  const corners = [nw, { lat: nw.lat, lon: se.lon }, se, { lat: se.lat, lon: nw.lon }, nw]
  const wkt = corners.map((p) => `${p.lon.toFixed(5)} ${p.lat.toFixed(5)}`).join(",")
  const where = `intersects(the_geom,'POLYGON((${wkt}))')`
  // Socrata returns rows in no fixed order; ordering by row id keeps the output stable.
  const boroughs = await download(BOROUGHS_URL, { $where: where, $order: ":id" }, "data/raw/boroughs.geojson", values.refresh)
  const centerline = await download(
    CENTERLINE_URL,
    { $select: "the_geom,rw_type", $where: where, $order: ":id", $limit: "50000" },
    "data/raw/centerline.geojson",
    values.refresh,
  )
  const data = toGroundData(boroughs, centerline, { box, step: values.fixture ? 1 : 0.1 })
  const out = values.out ?? (values.fixture ? "public/fixtures/ground.json" : "data/ground.json")
  mkdirSync(dirname(out), { recursive: true })
  const json = JSON.stringify(data)
  writeFileSync(out, json + "\n")
  const points = data.land.flat().reduce((n, r) => n + r.length / 2, 0)
  console.log(`${out}: ${data.land.length} land polygons (${points} points), ${data.streets.length} streets, ${(json.length / 1024).toFixed(0)} KB`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`fetch-ground failed: ${(error as Error).message}`)
    process.exitCode = 1
  })
}
