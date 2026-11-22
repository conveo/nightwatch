import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  ShapeUtils,
  Vector2,
} from "three"
import { AREA, WATER_LEVEL_M } from "../constants.ts"
import { toLocal } from "../geo.ts"
import type { Light } from "../view-state.ts"
import type { Layer } from "./types.ts"

// The ground: land, the water of the Leie and the Schelde, the streets and the
// bridges, from Digitaal Vlaanderen's GRB (scripts/fetch-ground.ts writes the
// fixture). Owned by ticket T2 in plan/PLAN.md.
//
// The land is one plane at street level (y = 0) whose texture holds the streets and
// bridges and is transparent over the water, so the water below it (at
// WATER_LEVEL_M) shows through the holes and quay walls line their edges. Bridges
// are part of that plane, so they stay at street level above the river.

// A point in scene metres: x east, z south of the Belfry.
export type XZ = [number, number]
// A closed ring, without the repeated first point.
export type Ring = XZ[]
// The first ring is the outline, any others are holes.
export type Polygon = Ring[]
export type Rect = { minX: number; minZ: number; maxX: number; maxZ: number }

export type GroundData = { area: Rect; water: Polygon[]; roads: Polygon[]; bridges: Polygon[] }

// public/fixtures/ground.json: each ring is a flat [x0, z0, x1, z1, ...] list in
// metres, rounded to 0.1 m, which keeps the whole area under 300 KB.
export type GroundFile = {
  source: string
  area: [number, number, number, number]
  water: number[][][]
  roads: number[][][]
  bridges: number[][][]
}

const COLORS = {
  land: "#2b303b",
  road: "#6b7385",
  bridge: "#7a8193",
  water: 0x2a5f9e,
  waterNight: 0x0d2a52,
  quay: 0x4b4f5a,
}
// The texture's resolution: about 2.8 pixels per metre over the whole area.
const TEXTURE_MAX_PX = 4096
// The width of the outline that closes slivers between neighbouring streets (metres).
const SLIVER_M = 0.6
// How much light of its own the land and the streets keep at night.
const NIGHT_GLOW = 0.35
// Quay walls reach a little below the water so no gap shows at the waterline.
const QUAY_BOTTOM_M = WATER_LEVEL_M - 0.5

// The drawn area as a rectangle in scene metres.
export function areaRect(): Rect {
  const nw = toLocal({ lat: AREA.north, lon: AREA.west })
  const se = toLocal({ lat: AREA.south, lon: AREA.east })
  return { minX: nw.x, minZ: nw.z, maxX: se.x, maxZ: se.z }
}

// GeoJSON positions ([lon, lat], first point repeated last) to a ring in metres.
export function ringFromLonLat(positions: readonly (readonly number[])[]): Ring {
  const ring: Ring = positions.map(([lon, lat]) => {
    const p = toLocal({ lat: lat!, lon: lon! })
    return [p.x, p.z]
  })
  return dropRepeats(ring)
}

// A GeoJSON Polygon or MultiPolygon geometry to polygons in metres; anything else is skipped.
export function polygonsFromGeometry(geometry: { type: string; coordinates: unknown } | null): Polygon[] {
  if (geometry == null) return []
  if (geometry.type === "Polygon") return [(geometry.coordinates as number[][][]).map(ringFromLonLat)]
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates as number[][][][]).map((polygon) => polygon.map(ringFromLonLat))
  }
  return []
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
  return Math.abs(ringArea(outer)) - holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0)
}

// Sutherland-Hodgman: the part of a ring inside an axis-aligned rectangle. Works for
// any ring because the rectangle is convex; where the ring leaves and re-enters, the
// result runs along the rectangle's edge, which draws as nothing.
export function clipRing(ring: Ring, rect: Rect): Ring {
  const edges: Array<{ inside: (p: XZ) => boolean; cut: (a: XZ, b: XZ) => XZ }> = [
    { inside: (p) => p[0] >= rect.minX, cut: (a, b) => atX(a, b, rect.minX) },
    { inside: (p) => p[0] <= rect.maxX, cut: (a, b) => atX(a, b, rect.maxX) },
    { inside: (p) => p[1] >= rect.minZ, cut: (a, b) => atZ(a, b, rect.minZ) },
    { inside: (p) => p[1] <= rect.maxZ, cut: (a, b) => atZ(a, b, rect.maxZ) },
  ]
  let out = ring
  for (const edge of edges) {
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!
      const prev = input[(i + input.length - 1) % input.length]!
      if (edge.inside(cur)) {
        if (!edge.inside(prev)) out.push(edge.cut(prev, cur))
        out.push(cur)
      } else if (edge.inside(prev)) {
        out.push(edge.cut(prev, cur))
      }
    }
    if (out.length === 0) break
  }
  return dropRepeats(out)
}

function atX(a: XZ, b: XZ, x: number): XZ {
  const t = (x - a[0]) / (b[0] - a[0])
  return [x, a[1] + t * (b[1] - a[1])]
}

function atZ(a: XZ, b: XZ, z: number): XZ {
  const t = (z - a[1]) / (b[1] - a[1])
  return [a[0] + t * (b[0] - a[0]), z]
}

// A polygon clipped to the rectangle, or null when too little of it is left.
export function clipPolygon(polygon: Polygon, rect: Rect): Polygon | null {
  const [outer, ...holes] = polygon
  if (outer == null) return null
  const clipped = clipRing(outer, rect)
  if (clipped.length < 3) return null
  return [clipped, ...holes.map((h) => clipRing(h, rect)).filter((h) => h.length >= 3)]
}

function segmentDistance2(p: XZ, a: XZ, b: XZ): number {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const len2 = dx * dx + dz * dz
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2))
  const ex = a[0] + t * dx - p[0]
  const ez = a[1] + t * dz - p[1]
  return ex * ex + ez * ez
}

// Douglas-Peucker on a closed ring: drops points that lie within `tolerance` metres of
// the simplified outline. The ring is split at its first point and the point farthest
// from it, so both halves keep their ends.
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (ring.length <= 4) return ring.slice()
  const first = ring[0]!
  let far = 1
  let farDist = -1
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i]![0] - first[0]) ** 2 + (ring[i]![1] - first[1]) ** 2
    if (d > farDist) {
      farDist = d
      far = i
    }
  }
  const points = [...ring, first]
  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = keep[far] = keep[points.length - 1] = true
  const tol2 = tolerance * tolerance
  const stack: Array<[number, number]> = [
    [0, far],
    [far, points.length - 1],
  ]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!
    let best = -1
    let bestDist = tol2
    for (let i = lo + 1; i < hi; i++) {
      const d = segmentDistance2(points[i]!, points[lo]!, points[hi]!)
      if (d > bestDist) {
        bestDist = d
        best = i
      }
    }
    if (best >= 0) {
      keep[best] = true
      stack.push([lo, best], [best, hi])
    }
  }
  return points.slice(0, -1).filter((_, i) => keep[i])
}

// Even-odd point in ring.
export function pointInRing(p: XZ, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!
    const [xj, zj] = ring[j]!
    if (zi > p[1] !== zj > p[1] && p[0] < xi + ((p[1] - zi) * (xj - xi)) / (zj - zi)) inside = !inside
  }
  return inside
}

export function pointInPolygon(p: XZ, polygon: Polygon): boolean {
  const [outer, ...holes] = polygon
  return outer != null && pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h))
}

export function encodeRing(ring: Ring): number[] {
  return ring.flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10])
}

export function decodeRing(flat: readonly number[]): Ring {
  const ring: Ring = []
  for (let i = 0; i + 1 < flat.length; i += 2) ring.push([flat[i]!, flat[i + 1]!])
  return ring
}

function decodePolygons(value: unknown, what: string): Polygon[] {
  if (!Array.isArray(value)) throw new Error(`ground fixture: "${what}" is not a list`)
  return value.map((polygon: unknown) => {
    if (!Array.isArray(polygon) || polygon.length === 0) throw new Error(`ground fixture: a polygon in "${what}" is empty`)
    return polygon.map((ring: unknown) => {
      if (!Array.isArray(ring) || ring.length < 6 || ring.length % 2 !== 0 || !ring.every(Number.isFinite)) {
        throw new Error(`ground fixture: a ring in "${what}" is not a flat list of x, z pairs`)
      }
      return decodeRing(ring as number[])
    })
  })
}

export function parseGroundFile(json: unknown): GroundData {
  const file = json as Partial<GroundFile> | null
  const area = file?.area
  if (!Array.isArray(area) || area.length !== 4 || !area.every(Number.isFinite)) {
    throw new Error('ground fixture: "area" must be [minX, minZ, maxX, maxZ]')
  }
  const [minX, minZ, maxX, maxZ] = area
  return {
    area: { minX, minZ, maxX, maxZ },
    water: decodePolygons(file!.water, "water"),
    roads: decodePolygons(file!.roads, "roads"),
    bridges: decodePolygons(file!.bridges, "bridges"),
  }
}

// Triangles for a flat polygon with holes (earcut, through three's ShapeUtils). The
// result indexes `points`, the outline followed by each hole, and every triangle
// faces up (+y) once the points are laid on the ground as (x, y, z).
export function triangulate(polygon: Polygon): { points: XZ[]; triangles: number[] } {
  const [outer, ...holes] = polygon
  if (outer == null || outer.length < 3) return { points: [], triangles: [] }
  const toV = (r: Ring) => r.map(([x, z]) => new Vector2(x, z))
  const faces = ShapeUtils.triangulateShape(toV(outer), holes.map(toV))
  const points = [outer, ...holes].flat()
  const triangles: number[] = []
  for (const [a, b, c] of faces) {
    const pa = points[a!]!
    const pb = points[b!]!
    const pc = points[c!]!
    // The y of (b - a) x (c - a): positive when the triangle faces up.
    const up = (pb[1] - pa[1]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[1] - pa[1])
    if (up === 0) continue
    triangles.push(...(up > 0 ? [a!, b!, c!] : [a!, c!, b!]))
  }
  return { points, triangles }
}

// One flat, upward-facing mesh geometry at height y for all the polygons.
export function surfaceGeometry(polygons: readonly Polygon[], y: number): BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  for (const polygon of polygons) {
    const { points, triangles } = triangulate(polygon)
    const base = positions.length / 3
    for (const [x, z] of points) positions.push(x, y, z)
    for (const i of triangles) indices.push(base + i)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3))
  geometry.setAttribute("normal", new Float32BufferAttribute(positions.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
  geometry.setIndex(indices)
  return geometry
}

function onRectEdge(a: XZ, b: XZ, rect: Rect, epsilon = 0.05): boolean {
  const near = (u: number, v: number) => Math.abs(u - v) < epsilon
  return (
    (near(a[0], rect.minX) && near(b[0], rect.minX)) ||
    (near(a[0], rect.maxX) && near(b[0], rect.maxX)) ||
    (near(a[1], rect.minZ) && near(b[1], rect.minZ)) ||
    (near(a[1], rect.maxZ) && near(b[1], rect.maxZ))
  )
}

type Bounded = { polygon: Polygon; minX: number; minZ: number; maxX: number; maxZ: number }

function bounded(polygons: readonly Polygon[]): Bounded[] {
  return polygons.map((polygon) => {
    const outer = polygon[0] ?? []
    const xs = outer.map((p) => p[0])
    const zs = outer.map((p) => p[1])
    return { polygon, minX: Math.min(...xs), minZ: Math.min(...zs), maxX: Math.max(...xs), maxZ: Math.max(...zs) }
  })
}

function inAny(p: XZ, polygons: readonly Bounded[]): boolean {
  return polygons.some(
    (b) => p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minZ && p[1] <= b.maxZ && pointInPolygon(p, b.polygon),
  )
}

// Every ring edge of the polygons, except very short ones and those on the area's border.
function polygonEdges(polygons: readonly Polygon[], rect: Rect): Array<[XZ, XZ]> {
  const edges: Array<[XZ, XZ]> = []
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!
        const b = ring[(i + 1) % ring.length]!
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 0.05 && !onRectEdge(a, b, rect)) edges.push([a, b])
      }
    }
  }
  return edges
}

// Walls are decided along each edge in steps of this length (metres), so an edge that
// is only partly over the water, or only partly a bank, gets a wall on that part.
const STEP_M = 0.5

// The parts of the edge a -> b where `keep` holds at the middle of each step, one edge
// per run of steps. `normal` is the edge's unit normal. With `widen`, each run grows by
// a step at both ends (within a and b), so it reaches the boundary it was cut at.
export function edgeRuns(a: XZ, b: XZ, keep: (p: XZ, normal: XZ) => boolean, widen = false): Array<[XZ, XZ]> {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (len === 0) return []
  const steps = Math.max(1, Math.ceil(len / STEP_M))
  const normal: XZ = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len]
  const at = (i: number): XZ => (i >= steps ? b : [a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps])
  const runs: Array<[XZ, XZ]> = []
  let start = -1
  for (let i = 0; i <= steps; i++) {
    const kept = i < steps && keep(at(i + 0.5), normal)
    if (kept && start < 0) start = i
    if (!kept && start >= 0) {
      runs.push(widen ? [at(Math.max(0, start - 1)), at(Math.min(steps, i + 1))] : [at(start), at(i)])
      start = -1
    }
  }
  return runs
}

// Quay walls: the water's edges where land meets it, skipping the seams between two
// water polygons (water on both sides) and the area's border.
export function quayEdges(water: readonly Polygon[], rect: Rect): Array<[XZ, XZ]> {
  const wet = bounded(water)
  // Half a metre to each side of the edge.
  const bank = (p: XZ, n: XZ) => inAny([p[0] + n[0] * 0.5, p[1] + n[1] * 0.5], wet) !== inAny([p[0] - n[0] * 0.5, p[1] - n[1] * 0.5], wet)
  return polygonEdges(water, rect).flatMap(([a, b]) => edgeRuns(a, b, bank))
}

// A bridge's sides: the parts of a bridge deck's edges that lie over the water. Runs
// are widened, so a side reaches the bank; the extra step is under the street-level
// ground, where it does not show.
export function bridgeEdges(bridges: readonly Polygon[], water: readonly Polygon[], rect: Rect): Array<[XZ, XZ]> {
  const wet = bounded(water)
  return polygonEdges(bridges, rect).flatMap(([a, b]) => edgeRuns(a, b, (p) => inAny(p, wet), true))
}

// Vertical quads from `top` down to `bottom` along each edge.
export function wallGeometry(edges: ReadonlyArray<readonly [XZ, XZ]>, top: number, bottom: number): BufferGeometry {
  const positions: number[] = []
  for (const [a, b] of edges) {
    positions.push(a[0], top, a[1], a[0], bottom, a[1], b[0], bottom, b[1])
    positions.push(a[0], top, a[1], b[0], bottom, b[1], b[0], top, b[1])
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

// The land texture: land, then the water cut out (transparent), then bridges and
// streets on top, so a bridge over the river stays opaque, at street level.
function paintGround(data: GroundData): HTMLCanvasElement {
  const { area } = data
  const width = area.maxX - area.minX
  const depth = area.maxZ - area.minZ
  const scale = TEXTURE_MAX_PX / Math.max(width, depth)
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(depth * scale)
  const ctx = canvas.getContext("2d")
  if (ctx == null) throw new Error("ground: no 2D canvas")
  // One path per kind, outlines wound one way and holes the other, filled "nonzero":
  // the union is antialiased once, so neighbouring polygons leave no seam between them.
  // The fixture simplifies each polygon on its own, so neighbours can drift apart by up
  // to half a metre; a thin outline of the same colour closes those slivers.
  const fill = (polygons: readonly Polygon[], outline: boolean) => {
    ctx.beginPath()
    for (const polygon of polygons) {
      polygon.forEach((ring, r) => {
        const wound = (ringArea(ring) > 0) === (r === 0) ? ring : ring.slice().reverse()
        wound.forEach(([x, z], i) => {
          const px = (x - area.minX) * scale
          const pz = (z - area.minZ) * scale
          if (i === 0) ctx.moveTo(px, pz)
          else ctx.lineTo(px, pz)
        })
        ctx.closePath()
      })
    }
    ctx.fill("nonzero")
    if (outline) ctx.stroke()
  }
  ctx.lineWidth = SLIVER_M * scale
  ctx.lineJoin = "round"
  ctx.fillStyle = COLORS.land
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.globalCompositeOperation = "destination-out"
  ctx.fillStyle = "#000"
  fill(data.water, false)
  ctx.globalCompositeOperation = "source-over"
  ctx.fillStyle = ctx.strokeStyle = COLORS.bridge
  fill(data.bridges, true)
  ctx.fillStyle = ctx.strokeStyle = COLORS.road
  fill(data.roads, true)
  return canvas
}

// Land around the area, so the city does not end in a hard edge against the sky.
function surroundGeometry(area: Rect, margin: number): BufferGeometry {
  const outer: Ring = [
    [area.minX - margin, area.minZ - margin],
    [area.maxX + margin, area.minZ - margin],
    [area.maxX + margin, area.maxZ + margin],
    [area.minX - margin, area.maxZ + margin],
  ]
  const hole: Ring = [
    [area.minX, area.minZ],
    [area.maxX, area.minZ],
    [area.maxX, area.maxZ],
    [area.minX, area.maxZ],
  ]
  return surfaceGeometry([[outer, hole]], 0)
}

export function createGroundLayer(): Layer {
  const group = new Group()
  group.name = "ground"
  const waterMaterial = new MeshLambertMaterial({ color: COLORS.water })
  const surroundMaterial = new MeshLambertMaterial({ color: new Color(COLORS.land) })
  let landMaterial: MeshLambertMaterial | null = null
  return {
    id: "ground",
    group,
    async init() {
      const res = await fetch(`${import.meta.env.BASE_URL}fixtures/ground.json`)
      if (!res.ok) throw new Error(`ground fixture: HTTP ${res.status}`)
      const data = parseGroundFile(await res.json())
      const { area } = data

      const texture = new CanvasTexture(paintGround(data))
      texture.colorSpace = SRGBColorSpace
      texture.anisotropy = 8
      landMaterial = new MeshLambertMaterial({ map: texture, alphaTest: 0.5, side: DoubleSide })
      const land = new Mesh(new PlaneGeometry(area.maxX - area.minX, area.maxZ - area.minZ), landMaterial)
      land.rotation.x = -Math.PI / 2
      land.position.set((area.minX + area.maxX) / 2, 0, (area.minZ + area.maxZ) / 2)
      land.name = "land"

      const surround = new Mesh(surroundGeometry(area, 6000), surroundMaterial)
      surround.name = "surround"
      const water = new Mesh(surfaceGeometry(data.water, WATER_LEVEL_M), waterMaterial)
      water.name = "water"
      const quayMaterial = new MeshLambertMaterial({ color: COLORS.quay, side: DoubleSide })
      const quays = new Mesh(wallGeometry(quayEdges(data.water, area), 0, QUAY_BOTTOM_M), quayMaterial)
      quays.name = "quays"
      const bridgeSides = new Mesh(wallGeometry(bridgeEdges(data.bridges, data.water, area), 0, -0.9), quayMaterial)
      bridgeSides.name = "bridge-sides"
      group.add(surround, water, quays, bridgeSides, land)
    },
    setLight(light: Light) {
      // At night the river keeps a faint glow, and the streets a little light of their
      // own, so both still read against the dark land.
      const night = light === "night"
      waterMaterial.emissive.set(night ? COLORS.waterNight : 0x000000)
      // The land around the area glows like the land inside it, so the edge stays seamless.
      surroundMaterial.emissive.set(night ? COLORS.land : 0x000000)
      surroundMaterial.emissiveIntensity = NIGHT_GLOW
      if (landMaterial != null) {
        landMaterial.emissiveMap = night ? landMaterial.map : null
        landMaterial.emissive.set(night ? 0xffffff : 0x000000)
        landMaterial.emissiveIntensity = NIGHT_GLOW
        landMaterial.needsUpdate = true
      }
    },
  }
}
