import {
  CanvasTexture,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Camera,
  type Object3D,
  type Raycaster,
} from "three"
import { AREA, GROUND_OVERLAY_Y_M } from "../constants.ts"
import { toLocal } from "../geo.ts"
import type { Light } from "../view-state.ts"
import type { Layer } from "./types.ts"

// The 2017 circulation plan: its sectors, the car-free area and the "knips" (the
// points where cars cannot pass from one sector to the next), from Stad Gent open
// data (scripts/fetch-circulation.ts writes the fixture). Owned by ticket T3 in
// plan/PLAN.md.
//
// Everything above createCirculationLayer() is pure and touches no DOM, so Node
// (the tests, the fetch script and the server's city state) can import this file.
// The zones are painted into one canvas texture on a plane at GROUND_OVERLAY_Y_M, so
// overlapping pieces never blend twice; the knips are red posts that grow with the
// camera's height, so they read from above as well as from the street.

// ---------------------------------------------------------------------------------
// Sector names, for the city state (server/city-state.ts) and `sector:<slug>`.

export type SectorKind = "sector" | "car-free"
export type Sector = { name: string; slug: string; kind: SectorKind }

// The car-free core. The data names its pieces "Kuip_VGG_<street>" (VGG is
// voetgangersgebied, the pedestrian area); "de Kuip" is Ghent's historic core.
export const CAR_FREE_AREA = "Kuip"

// The six sectors of the plan, clockwise from the north, and the car-free area. Only
// the Kuip, Tolhuis, Portus Ganda, Krook and Coupure reach into AREA; Rabot and
// Brugse Poort lie outside it but belong to the plan. scripts/fetch-circulation.ts
// checks this list against the data.
export const SECTORS: readonly Sector[] = [
  { name: CAR_FREE_AREA, slug: "kuip", kind: "car-free" },
  { name: "Tolhuis", slug: "tolhuis", kind: "sector" },
  { name: "Portus Ganda", slug: "portus-ganda", kind: "sector" },
  { name: "Krook", slug: "krook", kind: "sector" },
  { name: "Coupure", slug: "coupure", kind: "sector" },
  { name: "Brugse Poort", slug: "brugse-poort", kind: "sector" },
  { name: "Rabot", slug: "rabot", kind: "sector" },
]

export const SECTOR_NAMES: readonly string[] = SECTORS.map((s) => s.name)

export function sectorBySlug(slug: string): Sector | null {
  return SECTORS.find((s) => s.slug === slug) ?? null
}

// Lower case, ASCII, words joined by "-" ("Portus Ganda" -> "portus-ganda").
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
    .join("-")
}

// ---------------------------------------------------------------------------------
// The source data (sectoren-circulatieplan-gent and knips-circulatieplan-gent).

// A point in scene metres: x east, z south of the Belfry.
export type XZ = [number, number]
// A closed ring, without the repeated first point.
export type Ring = XZ[]
// The first ring is the outline, any others are holes.
export type Polygon = Ring[]
export type Rect = { minX: number; minZ: number; maxX: number; maxZ: number }

// A sector, a car-free piece, or a pedestrian street (drawn lighter, inside the
// car-free area it belongs to and picked as that area).
export type ZoneKind = "sector" | "car-free" | "pedestrian"
export type KnipKind = "posts" | "camera" | "median"

export type Geometry = { type: string; coordinates: unknown } | null
export type SourceFeature = { geometry: Geometry; properties: Record<string, unknown> | null }
export type SourceZone = { name: string; kind: ZoneKind; geometry: Geometry }

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

// "Kuip_VGG_Patershol" -> "Kuip"; a name without the marker is an area of its own.
function carFreeAreaName(naam: string): string {
  const at = naam.indexOf("_VGG_")
  return at > 0 ? naam.slice(0, at) : naam
}

// Each feature of sectoren-circulatieplan-gent to the zone it belongs to. Sectors have
// the zone "Sector <name>"; every other piece is car-free ("Autovrij ...") or a
// pedestrian street ("Voetgangersstraat ..."). A piece without a name joins the
// car-free area that shares its code (autovrijgebied); one with neither is skipped.
export function classifySectorFeatures(features: readonly SourceFeature[]): { zones: SourceZone[]; skipped: number } {
  const read = (f: SourceFeature) => {
    const p = f.properties ?? {}
    return {
      naam: text(p.naam),
      zone: text(p.zone) ?? "",
      code: text(p.autovrijgebied_codedvalue) ?? text(p.autovrijgebied),
    }
  }
  const areaByCode = new Map<string, string>()
  for (const f of features) {
    const { naam, zone, code } = read(f)
    if (naam != null && code != null && !zone.startsWith("Sector ") && !areaByCode.has(code)) {
      areaByCode.set(code, carFreeAreaName(naam))
    }
  }
  const zones: SourceZone[] = []
  let skipped = 0
  for (const f of features) {
    const { naam, zone, code } = read(f)
    if (zone.startsWith("Sector ")) {
      zones.push({ name: naam ?? zone.slice("Sector ".length), kind: "sector", geometry: f.geometry })
      continue
    }
    const name = naam != null ? carFreeAreaName(naam) : code != null ? (areaByCode.get(code) ?? null) : null
    if (name == null) {
      skipped++
      continue
    }
    zones.push({ name, kind: zone.startsWith("Voetgangersstraat") ? "pedestrian" : "car-free", geometry: f.geometry })
  }
  return { zones, skipped }
}

export function knipKind(type: unknown): KnipKind {
  const t = (text(type) ?? "").toLowerCase()
  if (t.includes("camera")) return "camera"
  if (t.includes("middenberm")) return "median"
  return "posts"
}

// GeoJSON positions ([lon, lat]) to points in metres.
export function pointsFromLonLat(positions: readonly (readonly number[])[]): XZ[] {
  return positions.map(([lon, lat]) => {
    const p = toLocal({ lat: lat!, lon: lon! })
    return [p.x, p.z]
  })
}

// A GeoJSON Polygon or MultiPolygon to polygons in metres; anything else is skipped.
export function polygonsFromGeometry(geometry: Geometry): Polygon[] {
  if (geometry == null) return []
  const polygon = (rings: number[][][]) => rings.map((ring) => dropRepeats(pointsFromLonLat(ring)))
  if (geometry.type === "Polygon") return [polygon(geometry.coordinates as number[][][])]
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as number[][][][]).map(polygon)
  return []
}

// A GeoJSON LineString or MultiLineString to lines in metres; anything else is skipped.
export function linesFromGeometry(geometry: Geometry): XZ[][] {
  if (geometry == null) return []
  if (geometry.type === "LineString") return [pointsFromLonLat(geometry.coordinates as number[][])]
  if (geometry.type === "MultiLineString") return (geometry.coordinates as number[][][]).map(pointsFromLonLat)
  return []
}

// ---------------------------------------------------------------------------------
// Plane geometry.

// The drawn area as a rectangle in scene metres, rounded to 0.1 m like the fixture.
export function areaRect(): Rect {
  const nw = toLocal({ lat: AREA.north, lon: AREA.west })
  const se = toLocal({ lat: AREA.south, lon: AREA.east })
  return { minX: round1(nw.x), minZ: round1(nw.z), maxX: round1(se.x), maxZ: round1(se.z) }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

// Consecutive repeated points (and a repeated closing point) removed.
export function dropRepeats(ring: Ring, epsilon = 1e-9): Ring {
  const out: Ring = []
  for (const p of ring) {
    const last = out[out.length - 1]
    if (last == null || Math.abs(last[0] - p[0]) > epsilon || Math.abs(last[1] - p[1]) > epsilon) out.push(p)
  }
  while (out.length > 1) {
    const first = out[0]!
    const last = out[out.length - 1]!
    if (Math.abs(last[0] - first[0]) > epsilon || Math.abs(last[1] - first[1]) > epsilon) break
    out.pop()
  }
  return out
}

// Signed area (shoelace) in square metres.
export function ringArea(ring: Ring): number {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i]!
    const [x1, z1] = ring[(i + 1) % ring.length]!
    sum += x0 * z1 - x1 * z0
  }
  return sum / 2
}

export function polygonArea(polygon: Polygon): number {
  const [outer, ...holes] = polygon
  if (outer == null) return 0
  return Math.abs(ringArea(outer)) - holes.reduce((sum, hole) => sum + Math.abs(ringArea(hole)), 0)
}

// Sutherland-Hodgman against an axis-aligned rectangle. A concave ring that leaves
// and re-enters the rectangle gets edges along its border; they enclose no area, so
// fills and point tests are unaffected, and outlines skip them (onRectBorder).
export function clipRing(ring: Ring, rect: Rect): Ring {
  const edges: Array<[(p: XZ) => boolean, (a: XZ, b: XZ) => XZ]> = [
    [(p) => p[0] >= rect.minX, (a, b) => cutX(a, b, rect.minX)],
    [(p) => p[0] <= rect.maxX, (a, b) => cutX(a, b, rect.maxX)],
    [(p) => p[1] >= rect.minZ, (a, b) => cutZ(a, b, rect.minZ)],
    [(p) => p[1] <= rect.maxZ, (a, b) => cutZ(a, b, rect.maxZ)],
  ]
  let out = ring
  for (const [inside, cut] of edges) {
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!
      const prev = input[(i + input.length - 1) % input.length]!
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur))
        out.push(cur)
      } else if (inside(prev)) {
        out.push(cut(prev, cur))
      }
    }
    if (out.length === 0) break
  }
  return dropRepeats(out)
}

function cutX(a: XZ, b: XZ, x: number): XZ {
  const t = (x - a[0]) / (b[0] - a[0])
  return [x, a[1] + t * (b[1] - a[1])]
}

function cutZ(a: XZ, b: XZ, z: number): XZ {
  const t = (z - a[1]) / (b[1] - a[1])
  return [a[0] + t * (b[0] - a[0]), z]
}

// A polygon clipped to the rectangle, or null when nothing of its outline is left.
export function clipPolygon(polygon: Polygon, rect: Rect): Polygon | null {
  const [outer, ...holes] = polygon
  if (outer == null) return null
  const clipped = clipRing(outer, rect)
  if (clipped.length < 3 || Math.abs(ringArea(clipped)) < 1e-6) return null
  const keptHoles = holes.map((h) => clipRing(h, rect)).filter((h) => h.length >= 3 && Math.abs(ringArea(h)) > 1e-6)
  return [clipped, ...keptHoles]
}

// Douglas-Peucker on a closed ring, keeping the two points farthest apart as anchors.
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (ring.length <= 4) return ring
  const a = 0
  let b = 0
  let best = -1
  for (let i = 1; i < ring.length; i++) {
    const d = dist2(ring[0]!, ring[i]!)
    if (d > best) {
      best = d
      b = i
    }
  }
  const keep = new Array<boolean>(ring.length).fill(false)
  keep[a] = keep[b] = true
  const stack: Array<[number, number]> = [
    [a, b],
    [b, a + ring.length],
  ]
  while (stack.length > 0) {
    const [from, to] = stack.pop()!
    const p = ring[from % ring.length]!
    const q = ring[to % ring.length]!
    let far = -1
    let farD = tolerance
    for (let i = from + 1; i < to; i++) {
      const d = distToSegment(ring[i % ring.length]!, p, q)
      if (d > farD) {
        farD = d
        far = i
      }
    }
    if (far >= 0) {
      keep[far % ring.length] = true
      stack.push([from, far], [far, to])
    }
  }
  return ring.filter((_, i) => keep[i])
}

function dist2(a: XZ, b: XZ): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
}

export function distToSegment(p: XZ, a: XZ, b: XZ): number {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const len2 = dx * dx + dz * dz
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz))
}

// Even-odd over every ring, so a point in a hole is outside.
export function pointInPolygon(p: XZ, polygon: Polygon): boolean {
  let inside = false
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i]!
      const [xj, zj] = ring[j]!
      if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside
    }
  }
  return inside
}

// True for an edge that lies on the rectangle's border (an artefact of clipping).
export function onRectBorder(a: XZ, b: XZ, rect: Rect, epsilon = 0.05): boolean {
  const near = (u: number, v: number) => Math.abs(u - v) <= epsilon
  return (
    (near(a[0], rect.minX) && near(b[0], rect.minX)) ||
    (near(a[0], rect.maxX) && near(b[0], rect.maxX)) ||
    (near(a[1], rect.minZ) && near(b[1], rect.minZ)) ||
    (near(a[1], rect.maxZ) && near(b[1], rect.maxZ))
  )
}

// Flat [x0, z0, x1, z1, ...] in metres rounded to 0.1 m, as stored in the fixture.
export function encodePoints(points: readonly XZ[]): number[] {
  return points.flatMap(([x, z]) => [round1(x), round1(z)])
}

export function decodePoints(flat: readonly number[]): XZ[] {
  const out: XZ[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!])
  return out
}

// ---------------------------------------------------------------------------------
// The fixture (public/fixtures/circulation.json).

export type CirculationFile = {
  source: string
  // [minX, minZ, maxX, maxZ] in scene metres.
  area: [number, number, number, number]
  // One entry per zone name and kind; each polygon is a list of flat rings.
  zones: Array<{ name: string; kind: ZoneKind; polygons: number[][][] }>
  // Each knip is a short line, flat [x0, z0, x1, z1, ...].
  knips: Array<{ kind: KnipKind; line: number[] }>
}

export type Zone = { name: string; slug: string; kind: ZoneKind; polygons: Polygon[] }
export type Knip = { kind: KnipKind; line: XZ[] }
export type CirculationData = { area: Rect; zones: Zone[]; knips: Knip[] }

const ZONE_KINDS: readonly ZoneKind[] = ["sector", "car-free", "pedestrian"]
const KNIP_KINDS: readonly KnipKind[] = ["posts", "camera", "median"]

function isFlatPoints(value: unknown, min: number): value is number[] {
  return Array.isArray(value) && value.length >= min && value.length % 2 === 0 && value.every(Number.isFinite)
}

export function parseCirculationFile(json: unknown): CirculationData {
  const file = json as Partial<CirculationFile> | null
  const area = file?.area
  if (!Array.isArray(area) || area.length !== 4 || !area.every(Number.isFinite)) {
    throw new Error('circulation fixture: "area" must be [minX, minZ, maxX, maxZ]')
  }
  if (!Array.isArray(file?.zones)) throw new Error('circulation fixture: "zones" is not a list')
  if (!Array.isArray(file?.knips)) throw new Error('circulation fixture: "knips" is not a list')
  const zones = file.zones.map((zone, i): Zone => {
    if (typeof zone?.name !== "string" || zone.name === "") throw new Error(`circulation fixture: zone ${i} has no name`)
    if (!ZONE_KINDS.includes(zone.kind)) throw new Error(`circulation fixture: zone ${i} has an unknown kind`)
    if (!Array.isArray(zone.polygons)) throw new Error(`circulation fixture: zone ${i} has no polygons`)
    const polygons = zone.polygons.map((polygon) => {
      if (!Array.isArray(polygon) || polygon.length === 0 || !polygon.every((ring) => isFlatPoints(ring, 6))) {
        throw new Error(`circulation fixture: a polygon of "${zone.name}" is not a list of flat x, z rings`)
      }
      return polygon.map(decodePoints)
    })
    return { name: zone.name, slug: slugify(zone.name), kind: zone.kind, polygons }
  })
  const knips = file.knips.map((knip, i): Knip => {
    if (!KNIP_KINDS.includes(knip?.kind as KnipKind) || !isFlatPoints(knip.line, 2)) {
      throw new Error(`circulation fixture: knip ${i} is not a kind and a flat x, z line`)
    }
    return { kind: knip.kind, line: decodePoints(knip.line) }
  })
  const [minX, minZ, maxX, maxZ] = area
  return { area: { minX, minZ, maxX, maxZ }, zones, knips }
}

// The zone a point lies in, as its slug: car-free pieces and pedestrian streets first
// (they are painted on top), then the sectors.
export function zoneAt(data: CirculationData, p: XZ): string | null {
  for (const kinds of [["pedestrian", "car-free"], ["sector"]] as const) {
    for (const zone of data.zones) {
      if (!(kinds as readonly ZoneKind[]).includes(zone.kind)) continue
      if (zone.polygons.some((polygon) => pointInPolygon(p, polygon))) return zone.slug
    }
  }
  return null
}

// ---------------------------------------------------------------------------------
// Colours: neighbouring sectors differ, and the car-free area has a colour of its own.

// Bright hues that stay apart from the car-free gold and the knips' red. The greedy
// colouring hands them out in this order; in AREA, sectors 0 and 1 face each other
// across the Kuip, so each of them borders both 2 and 3: blues next to greens.
export const SECTOR_COLOURS: readonly string[] = ["#4f8dff", "#b266ff", "#2fd27a", "#8fe04a", "#ff7ac8"]
export const CAR_FREE_COLOUR = "#ffd04a"
export const PEDESTRIAN_COLOUR = "#fff1b8"
export const KNIP_COLOUR = 0xff2626

type Bounds = Rect
function boundsOf(polygons: readonly Polygon[]): Bounds {
  const b = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity }
  for (const polygon of polygons) {
    for (const [x, z] of polygon[0] ?? []) {
      b.minX = Math.min(b.minX, x)
      b.maxX = Math.max(b.maxX, x)
      b.minZ = Math.min(b.minZ, z)
      b.maxZ = Math.max(b.maxZ, z)
    }
  }
  return b
}

// True when a vertex of one comes within `tolerance` metres of an edge of the other.
// Edges on the rectangle's border (from clipping) do not count.
function touches(a: readonly Polygon[], b: readonly Polygon[], tolerance: number, rect: Rect | null): boolean {
  const near = (ps: readonly Polygon[], qs: readonly Polygon[]) => {
    for (const polygon of qs) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
          const s = ring[i]!
          const t = ring[(i + 1) % ring.length]!
          if (rect != null && onRectBorder(s, t, rect)) continue
          for (const p of ps) for (const r of p) for (const v of r) if (distToSegment(v, s, t) <= tolerance) return true
        }
      }
    }
    return false
  }
  return near(a, b) || near(b, a)
}

// Which zones share a border, by slug. Zones of one slug merge (the car-free pieces).
export function findNeighbours(
  zones: ReadonlyArray<{ slug: string; polygons: readonly Polygon[] }>,
  tolerance: number,
  rect: Rect | null = null,
): Map<string, Set<string>> {
  const bySlug = new Map<string, Polygon[]>()
  for (const zone of zones) bySlug.set(zone.slug, [...(bySlug.get(zone.slug) ?? []), ...zone.polygons])
  const slugs = [...bySlug.keys()]
  const bounds = new Map(slugs.map((s) => [s, boundsOf(bySlug.get(s)!)]))
  const out = new Map(slugs.map((s) => [s, new Set<string>()]))
  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      const a = slugs[i]!
      const b = slugs[j]!
      const ba = bounds.get(a)!
      const bb = bounds.get(b)!
      if (ba.minX > bb.maxX + tolerance || bb.minX > ba.maxX + tolerance) continue
      if (ba.minZ > bb.maxZ + tolerance || bb.minZ > ba.maxZ + tolerance) continue
      if (touches(bySlug.get(a)!, bySlug.get(b)!, tolerance, rect)) {
        out.get(a)!.add(b)
        out.get(b)!.add(a)
      }
    }
  }
  return out
}

// A palette index per sector such that no two neighbours share one. Most-connected
// sectors go first; each takes the free colour used least so far (lowest index on a
// tie), so a handful of sectors all get different colours.
export function colourSectors(
  slugs: readonly string[],
  neighbours: ReadonlyMap<string, ReadonlySet<string>>,
  paletteSize = SECTOR_COLOURS.length,
): Map<string, number> {
  const degree = (s: string) => neighbours.get(s)?.size ?? 0
  const order = [...slugs].sort((a, b) => degree(b) - degree(a) || slugs.indexOf(a) - slugs.indexOf(b))
  const colour = new Map<string, number>()
  const used = new Array<number>(paletteSize).fill(0)
  for (const slug of order) {
    const taken = new Set([...(neighbours.get(slug) ?? [])].map((n) => colour.get(n)).filter((c) => c != null))
    let pick = -1
    for (let c = 0; c < paletteSize; c++) if (!taken.has(c) && (pick < 0 || used[c]! < used[pick]!)) pick = c
    if (pick < 0) throw new Error(`no colour left for sector "${slug}": ${paletteSize} colours are not enough`)
    colour.set(slug, pick)
    used[pick]!++
  }
  return colour
}

// The point inside a polygon farthest from its edges (a grid search, refined three
// times): where a label sits best.
export function labelPoint(polygon: Polygon): XZ {
  const b = boundsOf([polygon])
  const clearance = (p: XZ) => {
    if (!pointInPolygon(p, polygon)) return -Infinity
    let d = Infinity
    for (const ring of polygon) for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSegment(p, ring[i]!, ring[(i + 1) % ring.length]!))
    return d
  }
  const steps = 24
  let cell = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / steps
  let best: XZ = polygon[0]![0]!
  let bestD = -Infinity
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const p: XZ = [b.minX + (i * (b.maxX - b.minX)) / steps, b.minZ + (j * (b.maxZ - b.minZ)) / steps]
      const d = clearance(p)
      if (d > bestD) [best, bestD] = [p, d]
    }
  }
  for (let round = 0; round < 3; round++) {
    const centre = best
    for (let i = -4; i <= 4; i++) {
      for (let j = -4; j <= 4; j++) {
        const p: XZ = [centre[0] + (i * cell) / 4, centre[1] + (j * cell) / 4]
        const d = clearance(p)
        if (d > bestD) [best, bestD] = [p, d]
      }
    }
    cell /= 4
  }
  return best
}

// Where to put a zone's label: in its largest piece (car-free pieces for the Kuip, not
// its pedestrian streets).
export function zoneLabels(data: CirculationData): Array<{ slug: string; name: string; kind: SectorKind; at: XZ }> {
  const out: Array<{ slug: string; name: string; kind: SectorKind; at: XZ }> = []
  for (const zone of data.zones) {
    if (zone.kind === "pedestrian" || out.some((l) => l.slug === zone.slug)) continue
    const pieces = data.zones.filter((z) => z.slug === zone.slug && z.kind === zone.kind).flatMap((z) => z.polygons)
    const largest = pieces.reduce((a, b) => (polygonArea(b) > polygonArea(a) ? b : a))
    out.push({ slug: zone.slug, name: zone.name, kind: zone.kind === "sector" ? "sector" : "car-free", at: labelPoint(largest) })
  }
  return out
}

// ---------------------------------------------------------------------------------
// Knips as posts.

// Posts along a knip's line, about `spacing` metres apart: at least the two ends, at
// most `max`.
export function knipPosts(line: readonly XZ[], spacing = 2.5, max = 6): XZ[] {
  if (line.length === 0) return []
  const lengths = [0]
  for (let i = 1; i < line.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]))
  const total = lengths[lengths.length - 1]!
  if (total === 0) return [line[0]!]
  const n = Math.max(2, Math.min(max, Math.round(total / spacing) + 1))
  const out: XZ[] = []
  for (let k = 0; k < n; k++) {
    const at = (total * k) / (n - 1)
    let i = 1
    while (i < line.length - 1 && lengths[i]! < at) i++
    const t = (at - lengths[i - 1]!) / (lengths[i]! - lengths[i - 1]! || 1)
    const a = line[i - 1]!
    const b = line[i]!
    out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
  }
  return out
}

// A post is a bollard (0.4 m wide, 1.2 m tall) at street level; seen from higher up it
// grows with the camera's height, so the knips still read from above.
export const POST_RADIUS_M = 0.4
export const POST_HEIGHT_M = 1.2
export function postScale(cameraHeight: number): number {
  return Math.max(1, Math.min(28, cameraHeight / 85))
}

// ---------------------------------------------------------------------------------
// The layer (browser only from here on: canvas and DOM are touched in init()).

// The zones' texture: its longer side in pixels (about 1.4 px per metre over AREA).
const TEXTURE_PX = 2048
const ALPHA = { sector: 0.52, "car-free": 0.72, pedestrian: 0.72 } as const
// Labels show when the camera looks down at least this steeply (the y of its forward
// vector), that is, when the zones are seen from above.
const LABELS_BELOW_Y = -0.75

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

function isShown(object: Object3D): boolean {
  for (let o: Object3D | null = object; o != null; o = o.parent) if (!o.visible) return false
  return true
}

function isInside(object: Object3D, ancestor: Object3D): boolean {
  for (let o: Object3D | null = object; o != null; o = o.parent) if (o === ancestor) return true
  return false
}

export function createCirculationLayer(): Layer {
  const group = new Group()
  group.name = "circulation"
  let data: CirculationData | null = null
  let colours = new Map<string, string>()
  let selected: string | null = null
  let canvas: HTMLCanvasElement | null = null
  let texture: CanvasTexture | null = null
  let plane: Mesh<PlaneGeometry, MeshBasicMaterial> | null = null
  let posts: InstancedMesh | null = null
  let postPoints: XZ[] = []
  let currentScale = 0
  let camera: Camera | null = null
  let labelBox: HTMLDivElement | null = null
  let labels: Array<{ slug: string; el: HTMLDivElement; at: Vector3 }> = []

  function paint(): void {
    if (data == null || canvas == null) return
    const ctx = canvas.getContext("2d")!
    const { area } = data
    const s = canvas.width / (area.maxX - area.minX)
    const path = (polygon: Polygon) => {
      ctx.beginPath()
      for (const ring of polygon) {
        ring.forEach(([x, z], i) => {
          if (i === 0) ctx.moveTo((x - area.minX) * s, (z - area.minZ) * s)
          else ctx.lineTo((x - area.minX) * s, (z - area.minZ) * s)
        })
        ctx.closePath()
      }
    }
    const outline = (polygon: Polygon) => {
      ctx.beginPath()
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!
          const b = ring[(i + 1) % ring.length]!
          if (onRectBorder(a, b, area)) continue
          ctx.moveTo((a[0] - area.minX) * s, (a[1] - area.minZ) * s)
          ctx.lineTo((b[0] - area.minX) * s, (b[1] - area.minZ) * s)
        }
      }
      ctx.stroke()
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.lineJoin = "round"
    ctx.lineCap = "round"
    for (const kind of ZONE_KINDS) {
      for (const zone of data.zones) {
        if (zone.kind !== kind) continue
        const colour = colours.get(zone.slug) ?? CAR_FREE_COLOUR
        for (const polygon of zone.polygons) {
          path(polygon)
          if (kind !== "sector") {
            // Car-free pieces replace whatever lies under them, so overlaps never mix.
            ctx.globalCompositeOperation = "destination-out"
            ctx.fillStyle = "#000"
            ctx.fill("evenodd")
            ctx.globalCompositeOperation = "source-over"
          }
          ctx.fillStyle = rgba(kind === "pedestrian" ? PEDESTRIAN_COLOUR : colour, ALPHA[kind])
          ctx.fill("evenodd")
        }
      }
    }
    // Borders: light lines between sectors, a bright edge around the car-free area.
    for (const zone of data.zones) {
      if (zone.kind === "pedestrian") continue
      ctx.strokeStyle = zone.kind === "sector" ? "rgba(255, 255, 255, 0.7)" : "rgba(255, 246, 214, 0.95)"
      ctx.lineWidth = 5
      for (const polygon of zone.polygons) outline(polygon)
    }
    if (selected != null) {
      for (const zone of data.zones) {
        if (zone.slug !== selected) continue
        for (const polygon of zone.polygons) {
          path(polygon)
          ctx.fillStyle = "rgba(255, 255, 255, 0.28)"
          ctx.fill("evenodd")
          ctx.strokeStyle = "#ffffff"
          ctx.lineWidth = 9
          outline(polygon)
        }
      }
    }
    if (texture != null) texture.needsUpdate = true
  }

  function placePosts(scale: number): void {
    if (posts == null) return
    const m = new Matrix4()
    const q = new Quaternion()
    const size = new Vector3(scale, scale, scale)
    postPoints.forEach(([x, z], i) => posts!.setMatrixAt(i, m.compose(new Vector3(x, GROUND_OVERLAY_Y_M, z), q, size)))
    posts.instanceMatrix.needsUpdate = true
    currentScale = scale
  }

  // Each label over its zone, in the scene canvas's page coordinates.
  function placeLabels(cam: Camera, sceneCanvas: HTMLCanvasElement): void {
    if (labelBox == null) return
    const show = cam.getWorldDirection(new Vector3()).y <= LABELS_BELOW_Y
    labelBox.style.display = show ? "" : "none"
    if (!show) return
    const box = sceneCanvas.getBoundingClientRect()
    for (const label of labels) {
      const p = label.at.clone().project(cam)
      const visible = p.z < 1 && Math.abs(p.x) < 0.98 && Math.abs(p.y) < 0.96
      label.el.style.display = visible ? "" : "none"
      if (!visible) continue
      const x = box.left + ((p.x + 1) / 2) * box.width
      const y = box.top + ((1 - p.y) / 2) * box.height
      label.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`
    }
  }

  function markLabels(): void {
    for (const label of labels) {
      label.el.style.outline = label.slug === selected ? "3px solid #ffffff" : ""
      label.el.style.outlineOffset = label.slug === selected ? "6px" : ""
    }
  }

  function buildLabels(): void {
    if (data == null) return
    labelBox = document.createElement("div")
    labelBox.className = "circulation-labels"
    labelBox.setAttribute("aria-hidden", "true")
    Object.assign(labelBox.style, { position: "fixed", inset: "0", pointerEvents: "none", overflow: "hidden" })
    labels = zoneLabels(data).map((l) => {
      const el = document.createElement("div")
      Object.assign(el.style, {
        position: "absolute",
        left: "0",
        top: "0",
        textAlign: "center",
        whiteSpace: "nowrap",
        fontSize: "28px",
        fontWeight: "700",
        lineHeight: "1.1",
        color: "#ffffff",
        textShadow: "0 0 6px rgba(0, 0, 0, 0.95), 0 1px 3px rgba(0, 0, 0, 0.95)",
      })
      el.textContent = l.name
      if (l.kind === "car-free") {
        const sub = document.createElement("div")
        Object.assign(sub.style, { fontSize: "24px", fontWeight: "600", color: "#ffe7a3" })
        sub.textContent = "car-free"
        el.append(sub)
      }
      labelBox!.append(el)
      return { slug: l.slug, el, at: new Vector3(l.at[0], GROUND_OVERLAY_Y_M, l.at[1]) }
    })
    // Before the HUD and the panels in the page, so they stay on top of the labels.
    const scene = document.querySelector("#scene")
    if (scene != null) scene.after(labelBox)
    else document.body.append(labelBox)
  }

  return {
    id: "circulation",
    group,
    async init() {
      const res = await fetch(`${import.meta.env.BASE_URL}fixtures/circulation.json`)
      if (!res.ok) throw new Error(`circulation fixture: HTTP ${res.status}`)
      data = parseCirculationFile(await res.json())

      const sectors = data.zones.filter((z) => z.kind === "sector")
      const slugs = [...new Set(sectors.map((z) => z.slug))]
      const palette = colourSectors(slugs, findNeighbours(sectors, 6, data.area))
      colours = new Map([...palette].map(([slug, i]) => [slug, SECTOR_COLOURS[i]!]))

      const { area } = data
      const w = area.maxX - area.minX
      const h = area.maxZ - area.minZ
      canvas = document.createElement("canvas")
      canvas.width = Math.round((TEXTURE_PX * w) / Math.max(w, h))
      canvas.height = Math.round((TEXTURE_PX * h) / Math.max(w, h))
      texture = new CanvasTexture(canvas)
      texture.colorSpace = SRGBColorSpace
      texture.anisotropy = 8
      paint()
      plane = new Mesh(
        new PlaneGeometry(w, h),
        new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }),
      )
      plane.name = "circulation-zones"
      plane.rotation.x = -Math.PI / 2
      plane.position.set((area.minX + area.maxX) / 2, GROUND_OVERLAY_Y_M, (area.minZ + area.maxZ) / 2)
      // Always "drawn", so onBeforeRender hands over the camera for the labels and posts.
      plane.frustumCulled = false
      plane.onBeforeRender = (renderer, _scene, cam) => {
        camera = cam
        placeLabels(cam, renderer.domElement)
      }

      postPoints = data.knips.flatMap((k) => knipPosts(k.line))
      const post = new CylinderGeometry(POST_RADIUS_M, POST_RADIUS_M, POST_HEIGHT_M, 14)
      post.translate(0, POST_HEIGHT_M / 2, 0)
      posts = new InstancedMesh(post, new MeshLambertMaterial({ color: KNIP_COLOUR, emissive: 0xa00c0c }), postPoints.length)
      posts.name = "circulation-knips"
      // The posts grow with the camera, so their bounds change: never cull them.
      posts.frustumCulled = false
      placePosts(1)

      group.add(plane, posts)
      buildLabels()
      markLabels()
    },
    update() {
      if (labelBox != null && !isShown(group)) labelBox.style.display = "none"
      if (camera == null || posts == null) return
      const scale = postScale(camera.position.y)
      if (Math.abs(scale - currentScale) > currentScale * 0.02) placePosts(scale)
    },
    setLight(light: Light) {
      if (plane != null) plane.material.opacity = light === "night" ? 0.85 : 1
    },
    pick(ray: Raycaster) {
      if (data == null || plane == null || !isShown(group)) return null
      // Only when the zones are the first thing the ray meets: a building or anything
      // else standing on them belongs to its own layer's pick.
      let root: Object3D = group
      while (root.parent != null) root = root.parent
      const first = ray.intersectObject(root, true).find((hit) => isShown(hit.object))
      if (first == null || !isInside(first.object, group)) return null
      const slug = zoneAt(data, [first.point.x, first.point.z])
      return slug == null ? null : `sector:${slug}`
    },
    select(id: string | null) {
      const next = id != null && id.startsWith("sector:") ? id.slice("sector:".length) : null
      if (next === selected) return
      selected = next
      markLabels()
      paint()
    },
  }
}
