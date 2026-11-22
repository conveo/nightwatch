import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LinearFilter,
  NearestFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PointLight,
  RepeatWrapping,
  RGBAFormat,
  RingGeometry,
  Sphere,
  SpotLight,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Ray,
  type Raycaster,
} from "three"
import { AREA, GROUND_OVERLAY_Y_M } from "../constants.ts"
import { toLocal } from "../geo.ts"
import type { Light } from "../view-state.ts"
import type { Layer } from "./types.ts"

// The Lichtplan: the city's night lighting of its towers, bridges, quays and facades,
// and the Lichtplan walk between them, from Stad Gent open data
// (points-of-interest-poi-lichtplan-gent and route-lichtplan-gent;
// scripts/fetch-lichtplan.ts writes the fixture). Owned by ticket T4 in plan/PLAN.md.
//
// At night a few real lights (at most MAX_REAL_LIGHTS) floodlight the towers and
// light the bridges, every other point glows as a warm sprite, and the walk is a
// glowing ribbon at street level. By day the points are small markers and the walk a
// thin dashed line. The data does not change, so the fixture covers the whole area and
// every data mode draws it.

// A point in scene metres: x east, z south of the Belfry.
export type XZ = [number, number]
export type Rect = { minX: number; minZ: number; maxX: number; maxZ: number }

export type LichtplanPoint = {
  // The dataset's objectid: the selection is `poi:<id>`.
  id: number
  // The stop's number on the walk, when it has one.
  n: number | null
  // The dataset's "soort" (kind of place) as published, e.g. "Belfort", "Brug", "Straat".
  kind: string
  nl: string
  en: string | null
  x: number
  z: number
}

export type LichtplanLine = {
  id: number
  // "hoofdroute" (the walk), "uitbreiding" (an extension) or "doorsteek" (a shortcut).
  type: string
  points: XZ[]
}

export type LichtplanData = { points: LichtplanPoint[]; lines: LichtplanLine[] }

// public/fixtures/lichtplan.json: coordinates in scene metres, rounded to 0.1 m; each
// line is a flat [x0, z0, x1, z1, ...] list.
export type LichtplanFile = {
  source: string
  points: Array<{ id: number; n: number | null; kind: string; nl: string; en: string | null; x: number; z: number }>
  lines: Array<{ id: number; type: string; xz: number[] }>
}

export type PoiKind = "tower" | "bridge" | "other"

// Real lights cost every lit material a little per pixel, so only this many points
// get one; the rest glow on their own.
export const MAX_REAL_LIGHTS = 8

const COLORS = {
  warm: 0xffb066,
  glow: 0xffb25e,
  path: 0xffc070,
  marker: 0xd9a547,
  dayPath: 0x4a4339,
  selected: 0xfff1c2,
}

// Heights and sizes, in metres.
const GLOW_Y_M = 7
const GLOW_SIZE_M = 26
const PICK_Y_M = 6
const PICK_RADIUS_M = 10
// A tower's floodlight stands this far from the tower and this high up, on its
// west-south-west side, which faces the Street-level view from the Sint-Michielsbrug
// and the default view from the south-west. It aims at this height on the tower: from
// there the light reaches the foot and the top of a 90 m tower about evenly.
const FLOOD_DISTANCE_M = 90
const FLOOD_Y_M = 35
const FLOOD_DIRECTION: XZ = normalize([-0.92, 0.38])
const FLOOD_AIM_Y_M = 45
const BRIDGE_LIGHT_Y_M = 8
// The walk lies just above the circulation plan's zones (GROUND_OVERLAY_Y_M).
const PATH_Y_M = GROUND_OVERLAY_Y_M + 0.2
// The see-through copy of the night walk, seen from 60 m up (none below 30 m).
const WALK_THROUGH_OPACITY = 0.5
const NIGHT_PATH_WIDTH_M = 14
const DAY_PATH_WIDTH_M = 1.2
const DAY_DASH_PERIOD_M = 8
// Pieces of the walk shorter than this, left over from clipping to AREA, are dropped.
const MIN_LINE_M = 10

// --- Parsing --------------------------------------------------------------------

type Feature = {
  type?: string
  geometry: { type: string; coordinates: unknown } | null
  properties: Record<string, unknown> | null
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n)
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

function lonLat(position: unknown): { lat: number; lon: number } | null {
  if (!Array.isArray(position) || !finite(position[0]) || !finite(position[1])) return null
  return { lon: position[0], lat: position[1] }
}

// Stad Gent's GeoJSON export of points-of-interest-poi-lichtplan-gent to points in
// scene metres. A feature without an objectid or a position is skipped.
export function pointsFromGeoJson(features: readonly Feature[]): LichtplanPoint[] {
  const out: LichtplanPoint[] = []
  for (const f of features) {
    const p = f.properties ?? {}
    const id = p.objectid
    if (!finite(id) || !Number.isInteger(id)) continue
    // The export carries the point as the geometry and again as geo_point_2d.
    const fallback = p.geo_point_2d as { lat?: unknown; lon?: unknown } | null | undefined
    const at =
      (f.geometry?.type === "Point" ? lonLat(f.geometry.coordinates) : null) ??
      (fallback != null && finite(fallback.lat) && finite(fallback.lon) ? { lat: fallback.lat, lon: fallback.lon } : null)
    if (at == null) continue
    const { x, z } = toLocal(at)
    out.push({
      id,
      n: finite(p.volgnummer) ? p.volgnummer : null,
      kind: text(p.soort) ?? "",
      nl: text(p.naam_nl) ?? `Lichtplan ${id}`,
      en: text(p.naam_en),
      x,
      z,
    })
  }
  return out
}

// The main walk first, then by objectid, so the first of two identical lines kept
// is the walk itself.
function lineOrder(a: Feature, b: Feature): number {
  const rank = (f: Feature) => (f.properties?.type === "hoofdroute" ? 0 : 1)
  const id = (f: Feature) => (finite(f.properties?.objectid) ? (f.properties.objectid as number) : Infinity)
  return rank(a) - rank(b) || id(a) - id(b)
}

// Stad Gent's GeoJSON export of route-lichtplan-gent to lines in scene metres. The
// dataset publishes one of its lines twice (the walk and an "extension" with the very
// same geometry); a line identical to one already kept is dropped, so it is not drawn
// twice as bright.
export function linesFromGeoJson(features: readonly Feature[]): LichtplanLine[] {
  const out: LichtplanLine[] = []
  const seen = new Set<string>()
  for (const f of [...features].sort(lineOrder)) {
    const p = f.properties ?? {}
    const id = p.objectid
    if (!finite(id) || f.geometry == null) continue
    const parts =
      f.geometry.type === "LineString"
        ? [f.geometry.coordinates]
        : f.geometry.type === "MultiLineString"
          ? (f.geometry.coordinates as unknown[])
          : []
    for (const part of parts) {
      if (!Array.isArray(part)) continue
      const points: XZ[] = []
      for (const position of part) {
        const at = lonLat(position)
        if (at == null) continue
        const { x, z } = toLocal(at)
        points.push([x, z])
      }
      const line = dropRepeats(points)
      if (line.length < 2) continue
      const key = JSON.stringify(part)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ id, type: text(p.type) ?? "", points: line })
    }
  }
  return out
}

function round1(n: number): number {
  return Math.round(n * 10) / 10 || 0
}

export function encodeFile(data: LichtplanData, source: string): LichtplanFile {
  return {
    source,
    points: data.points.map((p) => ({ id: p.id, n: p.n, kind: p.kind, nl: p.nl, en: p.en, x: round1(p.x), z: round1(p.z) })),
    lines: data.lines.map((l) => ({ id: l.id, type: l.type, xz: l.points.flatMap(([x, z]) => [round1(x), round1(z)]) })),
  }
}

// The fixture back to points and lines. Throws on a file of the wrong shape, so a
// broken fixture is a layer error in the HUD rather than an empty scene.
export function parseLichtplanFile(raw: unknown): LichtplanData {
  const file = raw as Partial<LichtplanFile> | null
  if (file == null || !Array.isArray(file.points) || !Array.isArray(file.lines)) {
    throw new Error("lichtplan fixture: expected { points: [...], lines: [...] }")
  }
  const points: LichtplanPoint[] = []
  for (const p of file.points) {
    if (!finite(p?.id) || !finite(p.x) || !finite(p.z)) throw new Error("lichtplan fixture: a point needs id, x and z")
    points.push({
      id: p.id,
      n: finite(p.n) ? p.n : null,
      kind: typeof p.kind === "string" ? p.kind : "",
      nl: typeof p.nl === "string" ? p.nl : `Lichtplan ${p.id}`,
      en: typeof p.en === "string" ? p.en : null,
      x: p.x,
      z: p.z,
    })
  }
  const lines: LichtplanLine[] = []
  for (const l of file.lines) {
    if (!finite(l?.id) || !Array.isArray(l.xz) || l.xz.length % 2 !== 0 || !l.xz.every(finite)) {
      throw new Error("lichtplan fixture: a line needs id and an even list of coordinates")
    }
    const xz: XZ[] = []
    for (let i = 0; i < l.xz.length; i += 2) xz.push([l.xz[i]!, l.xz[i + 1]!])
    lines.push({ id: l.id, type: typeof l.type === "string" ? l.type : "", points: xz })
  }
  return { points, lines }
}

// --- Geometry helpers -----------------------------------------------------------

function normalize([x, z]: XZ): XZ {
  const len = Math.hypot(x, z)
  return len === 0 ? [0, 0] : [x / len, z / len]
}

// Consecutive repeated points removed.
export function dropRepeats(line: readonly XZ[], epsilon = 1e-6): XZ[] {
  const out: XZ[] = []
  for (const p of line) {
    const last = out[out.length - 1]
    if (last == null || Math.abs(last[0] - p[0]) > epsilon || Math.abs(last[1] - p[1]) > epsilon) out.push([p[0], p[1]])
  }
  return out
}

export function lineLength(line: readonly XZ[]): number {
  let sum = 0
  for (let i = 1; i < line.length; i++) sum += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1])
  return sum
}

// The drawn area as a rectangle in scene metres.
export function areaRect(): Rect {
  const nw = toLocal({ lat: AREA.north, lon: AREA.west })
  const se = toLocal({ lat: AREA.south, lon: AREA.east })
  return { minX: nw.x, minZ: nw.z, maxX: se.x, maxZ: se.z }
}

export function inRect([x, z]: XZ, r: Rect): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ
}

// Liang-Barsky: the part of segment a-b inside the rectangle, or null.
function clipSegment(a: XZ, b: XZ, r: Rect): [XZ, XZ] | null {
  let t0 = 0
  let t1 = 1
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const edges: Array<[number, number]> = [
    [-dx, a[0] - r.minX],
    [dx, r.maxX - a[0]],
    [-dz, a[1] - r.minZ],
    [dz, r.maxZ - a[1]],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return null
      if (t > t0) t0 = t
    } else {
      if (t < t0) return null
      if (t < t1) t1 = t
    }
  }
  // Ends inside the rectangle stay exactly as they were, so consecutive segments join.
  return [t0 === 0 ? [a[0], a[1]] : [a[0] + t0 * dx, a[1] + t0 * dz], t1 === 1 ? [b[0], b[1]] : [a[0] + t1 * dx, a[1] + t1 * dz]]
}

// The parts of a line inside the rectangle: a line that leaves and comes back gives
// two pieces.
export function clipPolyline(line: readonly XZ[], r: Rect): XZ[][] {
  const out: XZ[][] = []
  let current: XZ[] | null = null
  for (let i = 0; i + 1 < line.length; i++) {
    const seg = clipSegment(line[i]!, line[i + 1]!, r)
    if (seg == null) {
      if (current != null) out.push(current)
      current = null
      continue
    }
    const [a, b] = seg
    const last = current?.[current.length - 1]
    if (current != null && last != null && last[0] === a[0] && last[1] === a[1]) current.push(b)
    else {
      if (current != null) out.push(current)
      current = [a, b]
    }
  }
  if (current != null) out.push(current)
  return out.map((l) => dropRepeats(l)).filter((l) => l.length >= 2)
}

// Points inside AREA, and the lines clipped to it, without short leftovers.
export function clipToArea(data: LichtplanData, r: Rect = areaRect()): LichtplanData {
  return {
    points: data.points.filter((p) => inRect([p.x, p.z], r)),
    lines: data.lines.flatMap((l) =>
      clipPolyline(l.points, r)
        .filter((piece) => lineLength(piece) >= MIN_LINE_M)
        .map((points) => ({ ...l, points })),
    ),
  }
}

// A flat ribbon `width` metres wide along each line, at height y, facing up. The
// texture's v runs across the ribbon (0 on one edge, 1 on the other) and u along it,
// in widths. Corners are mitred, with the mitre capped so a sharp turn cannot spike.
export function ribbonGeometry(lines: readonly (readonly XZ[])[], width: number, y: number): BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const index: number[] = []
  const half = width / 2
  for (const raw of lines) {
    const line = dropRepeats(raw)
    if (line.length < 2) continue
    const base = positions.length / 3
    let along = 0
    for (let i = 0; i < line.length; i++) {
      const p = line[i]!
      const prev = line[i - 1]
      const next = line[i + 1]
      const dIn = prev == null ? null : normalize([p[0] - prev[0], p[1] - prev[1]])
      const dOut = next == null ? null : normalize([next[0] - p[0], next[1] - p[1]])
      // The side normal of a direction (x, z) is (-z, x).
      const nIn: XZ | null = dIn == null ? null : [-dIn[1], dIn[0]]
      const nOut: XZ | null = dOut == null ? null : [-dOut[1], dOut[0]]
      let n: XZ = (nIn ?? nOut)!
      let scale = 1
      if (nIn != null && nOut != null) {
        const m = normalize([nIn[0] + nOut[0], nIn[1] + nOut[1]])
        if (m[0] !== 0 || m[1] !== 0) {
          n = m
          scale = Math.min(2, 1 / Math.max(0.5, m[0] * nIn[0] + m[1] * nIn[1]))
        } else n = nOut
      }
      if (prev != null) along += Math.hypot(p[0] - prev[0], p[1] - prev[1])
      const w = half * scale
      positions.push(p[0] + n[0] * w, y, p[1] + n[1] * w, p[0] - n[0] * w, y, p[1] - n[1] * w)
      normals.push(0, 1, 0, 0, 1, 0)
      uvs.push(along / width, 0, along / width, 1)
      if (i > 0) {
        const a = base + (i - 1) * 2
        // Wound so the face normal points up (+y).
        index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
      }
    }
  }
  const g = new BufferGeometry()
  g.setAttribute("position", new Float32BufferAttribute(positions, 3))
  g.setAttribute("normal", new Float32BufferAttribute(normals, 3))
  g.setAttribute("uv", new Float32BufferAttribute(uvs, 2))
  g.setIndex(index)
  return g
}

// --- Which points get a real light -----------------------------------------------

const BRIDGE = /brug/i
const TOWER = /belfort|kathedraal|kerk|kasteel|toren|toreken|abdij/i

// Towers (the belfry, the cathedral, churches, the castle, small towers) and bridges,
// from the dataset's kind of place and the name.
export function poiKind(p: Pick<LichtplanPoint, "kind" | "nl">): PoiKind {
  if (BRIDGE.test(p.kind) || BRIDGE.test(p.nl)) return "bridge"
  if (TOWER.test(p.kind) || TOWER.test(p.nl)) return "tower"
  return "other"
}

function fromBelfry(p: LichtplanPoint): number {
  return Math.hypot(p.x, p.z)
}

// The points that get a real light: at most `max`, only towers and bridges. A
// quarter of the slots are kept for bridges; the towers nearest the Belfry take the
// rest, which puts Sint-Niklaas, the Belfry and Sint-Baafs, the three towers of the
// Street-level view, first. Slots left over go to more bridges.
export function chooseLitPoints(points: readonly LichtplanPoint[], max = MAX_REAL_LIGHTS): LichtplanPoint[] {
  if (max <= 0) return []
  const order = (a: LichtplanPoint, b: LichtplanPoint) => fromBelfry(a) - fromBelfry(b) || a.id - b.id
  const towers = points.filter((p) => poiKind(p) === "tower").sort(order)
  const bridges = points.filter((p) => poiKind(p) === "bridge").sort(order)
  const bridgeSlots = Math.min(bridges.length, Math.floor(max / 4))
  const litTowers = towers.slice(0, max - bridgeSlots)
  const litBridges = bridges.slice(0, max - litTowers.length)
  return [...litTowers, ...litBridges]
}

export type LightRig = {
  id: number
  type: "spot" | "point"
  position: [number, number, number]
  target: [number, number, number]
}

// Where a lit point's light stands: a tower gets a floodlight across from it, aimed
// up at it; a bridge a light above its deck.
export function lightRig(p: LichtplanPoint): LightRig {
  if (poiKind(p) === "bridge") {
    return { id: p.id, type: "point", position: [p.x, BRIDGE_LIGHT_Y_M, p.z], target: [p.x, 0, p.z] }
  }
  return {
    id: p.id,
    type: "spot",
    position: [p.x + FLOOD_DIRECTION[0] * FLOOD_DISTANCE_M, FLOOD_Y_M, p.z + FLOOD_DIRECTION[1] * FLOOD_DISTANCE_M],
    target: [p.x, FLOOD_AIM_Y_M, p.z],
  }
}

// --- Selection and picking ---------------------------------------------------------

export function poiSelection(id: number): string {
  return `poi:${id}`
}

export function parsePoiSelection(sel: string | null): number | null {
  const m = /^poi:(\d+)$/.exec(sel ?? "")
  return m == null ? null : Number(m[1])
}

// The point whose pick sphere the ray meets first, or null.
export function pickPoi(ray: Ray, points: readonly LichtplanPoint[], radius = PICK_RADIUS_M, y = PICK_Y_M): number | null {
  const sphere = new Sphere(new Vector3(), radius)
  const hit = new Vector3()
  let best: number | null = null
  let bestDistance = Infinity
  for (const p of points) {
    sphere.center.set(p.x, y, p.z)
    if (ray.intersectSphere(sphere, hit) == null) continue
    const d = hit.distanceTo(ray.origin)
    if (d < bestDistance) {
      bestDistance = d
      best = p.id
    }
  }
  return best
}

// --- Drawing ---------------------------------------------------------------------

// A white texture whose alpha falls off from a hot core: the glow of a light.
function glowTexture(size = 64): DataTexture {
  const data = new Uint8Array(size * size * 4)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const r = Math.hypot((i + 0.5) / size - 0.5, (j + 0.5) / size - 0.5) * 2
      const a = r >= 1 ? 0 : Math.min(1, Math.exp(-r * r * 18) + 0.45 * (1 - r) ** 2)
      data.set([255, 255, 255, Math.round(a * 255)], (j * size + i) * 4)
    }
  }
  return dataTexture(data, size, size)
}

// Alpha across the ribbon (v): a bright core with a soft halo on both sides.
function pathTexture(size = 64): DataTexture {
  const data = new Uint8Array(size * 4)
  for (let j = 0; j < size; j++) {
    const d = Math.abs((j + 0.5) / size - 0.5) * 2
    const a = Math.min(1, Math.exp(-((d * 3.2) ** 2)) + 0.4 * (1 - d) ** 2)
    data.set([255, 255, 255, Math.round(a * 255)], j * 4)
  }
  return dataTexture(data, 1, size)
}

// By day the walk is dashed, like a walking route on a map, and dark: a solid or light
// line on the dark ground reads as a lit one. A dash, then a gap, along the ribbon
// (u); used as an alpha map with alphaTest, so the gaps are cut out.
function dashTexture(): DataTexture {
  const t = dataTexture(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1)
  t.magFilter = NearestFilter
  t.minFilter = NearestFilter
  t.wrapS = RepeatWrapping
  return t
}

function dataTexture(data: Uint8Array, width: number, height: number): DataTexture {
  const t = new DataTexture(data, width, height, RGBAFormat)
  t.magFilter = LinearFilter
  t.minFilter = LinearFilter
  t.needsUpdate = true
  return t
}

function baseUrl(): string {
  // Vite sets import.meta.env; under node (the tests) it is undefined.
  return (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"
}

export function createLichtplanLayer(): Layer {
  const group = new Group()
  group.name = "lichtplan"
  // Night: the real lights, the glows and the glowing walk.
  const night = new Group()
  night.name = "lichtplan-night"
  const lights = new Group()
  lights.name = "lichtplan-lights"
  // Day: small markers and a thin line.
  const day = new Group()
  day.name = "lichtplan-day"
  const selection = new Group()
  selection.name = "lichtplan-selection"
  selection.visible = false
  night.add(lights)
  group.add(night, day, selection)

  let points: LichtplanPoint[] = []
  const glows = new Map<number, Sprite>()
  let light: Light = "day"
  let selected: string | null = null

  const glowMap = glowTexture()
  const glowMaterial = new SpriteMaterial({
    map: glowMap,
    color: COLORS.glow,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  })
  const selectedGlowMaterial = glowMaterial.clone()
  selectedGlowMaterial.color.set(COLORS.selected)

  function applyLight(): void {
    night.visible = light === "night"
    day.visible = light === "day"
  }

  function applySelection(): void {
    const id = parsePoiSelection(selected)
    const point = id == null ? undefined : points.find((p) => p.id === id)
    for (const [pid, sprite] of glows) {
      const on = point != null && pid === point.id
      sprite.material = on ? selectedGlowMaterial : glowMaterial
      const base = sprite.userData.size as number
      sprite.scale.set(base * (on ? 1.6 : 1), base * (on ? 1.6 : 1), 1)
    }
    selection.visible = point != null
    if (point != null) selection.position.set(point.x, 0, point.z)
  }

  function build(data: LichtplanData): void {
    points = data.points
    const lit = new Set(chooseLitPoints(points).map((p) => p.id))
    const warm = new Color(COLORS.warm)

    for (const p of points.filter((q) => lit.has(q.id))) {
      const rig = lightRig(p)
      if (rig.type === "spot") {
        const spot = new SpotLight(warm, 30000, 450, 0.62, 0.45, 2)
        spot.name = `lichtplan-light-${p.id}`
        spot.position.set(...rig.position)
        spot.target.position.set(...rig.target)
        lights.add(spot, spot.target)
      } else {
        const lamp = new PointLight(warm, 700, 160, 2)
        lamp.name = `lichtplan-light-${p.id}`
        lamp.position.set(...rig.position)
        lights.add(lamp)
      }
    }

    // Every point glows a little above the street, the lit towers and bridges
    // included, so each shows where it is and is selected by its glow alike.
    for (const p of points) {
      const sprite = new Sprite(glowMaterial)
      sprite.position.set(p.x, GLOW_Y_M, p.z)
      sprite.scale.set(GLOW_SIZE_M, GLOW_SIZE_M, 1)
      sprite.userData.size = GLOW_SIZE_M
      night.add(sprite)
      glows.set(p.id, sprite)
    }

    const walk = data.lines.map((l) => l.points)
    const pathMap = pathTexture()
    const glowPath = new Mesh(
      ribbonGeometry(walk, NIGHT_PATH_WIDTH_M, PATH_Y_M),
      new MeshBasicMaterial({
        color: COLORS.path,
        map: pathMap,
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    )
    glowPath.name = "lichtplan-walk-night"
    // From the air the walk runs between buildings that hide most of it, so a fainter
    // copy is drawn through the roofs; it fades out as the camera comes down to the
    // street, where the walk shows on its own.
    const throughMaterial = (glowPath.material as MeshBasicMaterial).clone()
    throughMaterial.depthTest = false
    const throughPath = new Mesh(glowPath.geometry, throughMaterial)
    throughPath.name = "lichtplan-walk-night-through"
    throughPath.renderOrder = 4
    throughPath.frustumCulled = false
    throughPath.onBeforeRender = (_renderer, _scene, camera) => {
      throughMaterial.opacity = WALK_THROUGH_OPACITY * Math.max(0, Math.min(1, (camera.position.y - 30) / 30))
    }
    night.add(glowPath, throughPath)

    const dashes = dashTexture()
    // The ribbon's u runs in widths along it; one repeat of the texture is one dash
    // and one gap.
    dashes.repeat.set(DAY_PATH_WIDTH_M / DAY_DASH_PERIOD_M, 1)
    const thinPath = new Mesh(
      ribbonGeometry(walk, DAY_PATH_WIDTH_M, PATH_Y_M),
      new MeshLambertMaterial({ color: COLORS.dayPath, alphaMap: dashes, alphaTest: 0.5, side: DoubleSide }),
    )
    thinPath.name = "lichtplan-walk-day"
    // A cone, tip down, standing just above the street.
    const cone = new ConeGeometry(2, 5, 12)
    cone.rotateX(Math.PI)
    cone.translate(0, 4, 0)
    const markers = new InstancedMesh(cone, new MeshLambertMaterial({ color: COLORS.marker }), points.length)
    markers.name = "lichtplan-markers"
    const m = new Matrix4()
    points.forEach((p, i) => markers.setMatrixAt(i, m.makeTranslation(p.x, 0, p.z)))
    markers.instanceMatrix.needsUpdate = true
    markers.computeBoundingSphere()
    day.add(thinPath, markers)

    // The selected point: a ring on the street and a beam of light above it.
    const ring = new Mesh(
      new RingGeometry(9, 12, 48),
      new MeshBasicMaterial({ color: COLORS.selected, side: DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = PATH_Y_M + 0.1
    const beam = new Mesh(
      new CylinderGeometry(0.9, 0.9, 70, 12, 1, true),
      new MeshBasicMaterial({
        color: COLORS.selected,
        transparent: true,
        opacity: 0.6,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    )
    beam.position.y = 35
    selection.add(ring, beam)
  }

  applyLight()
  return {
    id: "lichtplan",
    group,
    async init() {
      const res = await fetch(`${baseUrl()}fixtures/lichtplan.json`)
      if (!res.ok) throw new Error(`lichtplan fixture: HTTP ${res.status}`)
      build(parseLichtplanFile(await res.json()))
      applyLight()
      applySelection()
    },
    // main.ts calls this before init finishes too; the groups exist from the start.
    setLight(next: Light) {
      light = next
      applyLight()
    },
    pick(ray: Raycaster) {
      const id = pickPoi(ray.ray, points)
      return id == null ? null : poiSelection(id)
    },
    select(id: string | null) {
      selected = id
      applySelection()
    },
  }
}
