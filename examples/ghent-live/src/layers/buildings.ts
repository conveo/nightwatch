import {
  BufferAttribute,
  BufferGeometry,
  Color,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  ShapeUtils,
  Vector2,
  type Raycaster,
} from "three"
import { WATER_LEVEL_M } from "../constants.ts"
import type { DataMode, Light } from "../view-state.ts"
import type { Layer } from "./types.ts"

// The centre's buildings: GRB footprints (Digitaal Vlaanderen) extruded to their
// heights above the terrain from the DHMV II elevation model, coloured by height.
// scripts/fetch-buildings.ts writes the data; fixture mode reads the small sample in
// public/fixtures/, the other modes the whole area in data/buildings.json (served by
// the dev server, falling back to the fixture with a notice when it is missing).
//
// The buildings are merged into a few meshes, one per 400 m square, with a table from
// each triangle to its building, so a click answers `bldg:<OIDN>` (the GRB object id)
// and the selection is drawn as a highlighted copy of that one building.

// ---------------------------------------------------------------------------------
// The file format, written by scripts/fetch-buildings.ts.

// A ring is flat [x0, z0, x1, z1, …] in metres from the Belfry (x east, z south),
// without the closing point. A polygon is its outer ring followed by its holes.
export type Ring = number[]
export type Polygon = Ring[]

export type BuildingRecord = {
  // GRB object id (OIDN): the selection is `bldg:<id>`.
  id: number
  // Height of the body above the terrain, in metres.
  h: number
  // The footprint: usually one polygon.
  p: Polygon[]
  // Tall parts (towers) drawn over the body: an outline and the height of the shaft
  // each, and the height of the spire's tip when there is one.
  t?: { h: number; s?: number; r: Ring }[]
}

export type BuildingsFile = {
  source: string
  generated: string
  buildings: BuildingRecord[]
}

// ---------------------------------------------------------------------------------
// Selection ids

const PREFIX = "bldg:"

export function buildingSelection(id: number): string {
  return `${PREFIX}${id}`
}

// "bldg:1362089" → 1362089; anything else (another layer's id, a malformed one) → null.
export function parseBuildingSelection(sel: string | null): number | null {
  if (sel == null || !sel.startsWith(PREFIX)) return null
  const digits = sel.slice(PREFIX.length)
  return /^\d+$/.test(digits) ? Number(digits) : null
}

// OIDN → index in the buildings array.
export function indexBuildings(buildings: readonly BuildingRecord[]): Map<number, number> {
  return new Map(buildings.map((b, i) => [b.id, i]))
}

// ---------------------------------------------------------------------------------
// Colour by height: slate blue for low houses, light stone for the tall blocks, warm
// gold for the towers.

const RAMP: ReadonlyArray<[number, Color]> = [
  [0, new Color(0x3a4766)],
  [8, new Color(0x56688f)],
  [15, new Color(0x8496bb)],
  [24, new Color(0xc0c9db)],
  [40, new Color(0xe6cf98)],
  [90, new Color(0xffe2a0)],
]

export function colorForHeight(h: number, out = new Color()): Color {
  if (h <= RAMP[0]![0]) return out.copy(RAMP[0]![1])
  for (let i = 1; i < RAMP.length; i++) {
    const [h1, c1] = RAMP[i]!
    if (h <= h1) {
      const [h0, c0] = RAMP[i - 1]!
      return out.copy(c0).lerp(c1, (h - h0) / (h1 - h0))
    }
  }
  return out.copy(RAMP[RAMP.length - 1]![1])
}

export const HIGHLIGHT_COLOR = 0xff2ec4

// ---------------------------------------------------------------------------------
// Geometry

// Twice the signed area of a flat ring; positive is clockwise seen from above.
function area2(ring: Ring): number {
  let sum = 0
  const n = ring.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    sum += ring[2 * i]! * ring[2 * j + 1]! - ring[2 * j]! * ring[2 * i + 1]!
  }
  return sum
}

class GeometryWriter {
  positions: number[] = []
  normals: number[] = []
  colors: number[] = []
  owner: number[] = []
  private color = new Color()
  current = 0

  setColor(c: Color): void {
    this.color.copy(c)
  }

  triangle(a: number[], b: number[], c: number[], n: number[]): void {
    this.positions.push(...a, ...b, ...c)
    for (let i = 0; i < 3; i++) {
      this.normals.push(n[0]!, n[1]!, n[2]!)
      this.colors.push(this.color.r, this.color.g, this.color.b)
    }
    this.owner.push(this.current)
  }

  // Vertical walls along a ring from y0 to y1, facing away from the solid side:
  // inside an outer ring, outside a hole.
  walls(ring: Ring, outer: boolean, y0: number, y1: number): void {
    const n = ring.length / 2
    const flip = outer !== area2(ring) > 0
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      let [ax, az, bx, bz] = [ring[2 * i]!, ring[2 * i + 1]!, ring[2 * j]!, ring[2 * j + 1]!]
      if (flip) [ax, az, bx, bz] = [bx, bz, ax, az]
      const dx = bx - ax
      const dz = bz - az
      const len = Math.hypot(dx, dz)
      if (len < 1e-6) continue
      const normal = [dz / len, 0, -dx / len]
      this.triangle([ax, y0, az], [bx, y1, bz], [bx, y0, bz], normal)
      this.triangle([ax, y0, az], [ax, y1, az], [bx, y1, bz], normal)
    }
  }

  // A flat roof at height y over a polygon with holes.
  roof(polygon: Polygon, y: number): void {
    const contour = toVectors(polygon[0]!)
    const holes = polygon.slice(1).map(toVectors)
    // triangulateShape may drop a closing point, so index the rings it returns with.
    const faces = ShapeUtils.triangulateShape(contour, holes)
    const points = [contour, ...holes].flat()
    const up = [0, 1, 0]
    for (const [i, j, k] of faces) {
      const a = points[i!]!
      const b = points[j!]!
      const c = points[k!]!
      // Facing up: (b - a) × (c - a) has a positive y.
      const ny = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y)
      if (ny >= 0) this.triangle([a.x, y, a.y], [b.x, y, b.y], [c.x, y, c.y], up)
      else this.triangle([a.x, y, a.y], [c.x, y, c.y], [b.x, y, b.y], up)
    }
  }

  // A spire: a pyramid from a ring at height y0 to a tip at height y1 over its centre.
  spire(ring: Ring, y0: number, y1: number): void {
    const n = ring.length / 2
    let cx = 0
    let cz = 0
    for (let i = 0; i < n; i++) {
      cx += ring[2 * i]! / n
      cz += ring[2 * i + 1]! / n
    }
    const tip = [cx, y1, cz]
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      let a = [ring[2 * i]!, y0, ring[2 * i + 1]!]
      let b = [ring[2 * j]!, y0, ring[2 * j + 1]!]
      let normal = cross(sub(b, a), sub(tip, a))
      if (normal[1]! < 0) {
        ;[a, b] = [b, a]
        normal = normal.map((v) => -v)
      }
      const len = Math.hypot(...normal)
      if (len < 1e-9) continue
      this.triangle(a, b, tip, normal.map((v) => v / len))
    }
  }

  building(b: BuildingRecord, base: number, lift = 0): void {
    const color = new Color()
    this.setColor(colorForHeight(b.h, color))
    for (const polygon of b.p) {
      polygon.forEach((ring, i) => this.walls(ring, i === 0, base, b.h + lift))
      this.roof(polygon, b.h + lift)
    }
    for (const t of b.t ?? []) {
      this.setColor(colorForHeight(t.s ?? t.h, color))
      this.walls(t.r, true, base, t.h + lift)
      if (t.s != null) this.spire(t.r, t.h + lift, t.s + lift)
      else this.roof([t.r], t.h + lift)
    }
  }

  toGeometry(): BufferGeometry {
    const g = new BufferGeometry()
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.positions), 3))
    g.setAttribute("normal", new BufferAttribute(new Float32Array(this.normals), 3))
    g.setAttribute("color", new BufferAttribute(new Float32Array(this.colors), 3))
    g.computeBoundingSphere()
    return g
  }
}

const toVectors = (ring: Ring): Vector2[] => {
  const out: Vector2[] = []
  for (let i = 0; i < ring.length; i += 2) out.push(new Vector2(ring[i]!, ring[i + 1]!))
  return out
}
const sub = (a: number[], b: number[]): number[] => a.map((v, i) => v - b[i]!)
const cross = (a: number[], b: number[]): number[] => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
]

// The buildings merged into one geometry per CHUNK_M square (by the first vertex),
// so the camera culls whole squares. `owner[t]` is the index, in `buildings`, of the
// building that triangle t belongs to.
export const CHUNK_M = 400

export type Chunk = { geometry: BufferGeometry; owner: Uint32Array }

export function buildChunks(buildings: readonly BuildingRecord[], base = WATER_LEVEL_M): Chunk[] {
  const writers = new Map<string, GeometryWriter>()
  buildings.forEach((b, i) => {
    const ring = b.p[0]?.[0]
    if (ring == null) return
    const key = `${Math.floor(ring[0]! / CHUNK_M)},${Math.floor(ring[1]! / CHUNK_M)}`
    let w = writers.get(key)
    if (w == null) writers.set(key, (w = new GeometryWriter()))
    w.current = i
    w.building(b, base)
  })
  return [...writers.values()].map((w) => ({ geometry: w.toGeometry(), owner: Uint32Array.from(w.owner) }))
}

// The selected building, drawn on its own just above the original.
export function buildHighlight(b: BuildingRecord, base = WATER_LEVEL_M): BufferGeometry {
  const w = new GeometryWriter()
  w.building(b, base, 0.2)
  return w.toGeometry()
}

// The building a ray hits first, as `bldg:<OIDN>`, or null.
export function pickBuilding(
  ray: Raycaster,
  meshes: readonly Mesh[],
  buildings: readonly BuildingRecord[],
): string | null {
  const hit = ray.intersectObjects(meshes as Mesh[], false)[0]
  if (hit == null || hit.faceIndex == null) return null
  const owner = (hit.object.userData as { owner?: Uint32Array }).owner
  const index = owner?.[hit.faceIndex]
  const b = index == null ? undefined : buildings[index]
  return b == null ? null : buildingSelection(b.id)
}

// ---------------------------------------------------------------------------------
// The layer

function dataUrl(path: string): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? "/"
  return `${base}${path}`
}

async function loadFile(url: string): Promise<BuildingsFile | null> {
  const res = await fetch(url)
  if (!res.ok) return null
  // The dev server answers a missing file with the app's index.html.
  if (!(res.headers.get("content-type") ?? "").includes("json")) return null
  return (await res.json()) as BuildingsFile
}

async function loadBuildings(mode: DataMode): Promise<{ file: BuildingsFile; fallback: boolean }> {
  if (mode !== "fixture") {
    const full = await loadFile(dataUrl("data/buildings.json")).catch(() => null)
    if (full != null) return { file: full, fallback: false }
  }
  const fixture = await loadFile(dataUrl("fixtures/buildings.json"))
  if (fixture == null) throw new Error("no building data (public/fixtures/buildings.json)")
  return { file: fixture, fallback: mode !== "fixture" }
}

export function createBuildingsLayer(): Layer {
  const group = new Group()
  group.name = "buildings"
  const material = new MeshLambertMaterial({ vertexColors: true })
  const highlightMaterial = new MeshLambertMaterial({
    color: HIGHLIGHT_COLOR,
    emissive: HIGHLIGHT_COLOR,
    emissiveIntensity: 0.45,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  const outlineMaterial = new LineBasicMaterial({ color: 0xffffff })
  let buildings: BuildingRecord[] = []
  let index = new Map<number, number>()
  let meshes: Mesh[] = []
  let highlight: Group | null = null
  let selected: number | null = null
  let notice: string | null = null

  function showSelection(): void {
    if (highlight != null) {
      group.remove(highlight)
      for (const child of highlight.children) (child as Mesh | LineSegments).geometry.dispose()
      highlight = null
    }
    const i = selected == null ? undefined : index.get(selected)
    if (i == null) return
    const geometry = buildHighlight(buildings[i]!)
    highlight = new Group()
    highlight.name = "buildings-selection"
    highlight.add(new Mesh(geometry, highlightMaterial), new LineSegments(new EdgesGeometry(geometry, 30), outlineMaterial))
    group.add(highlight)
  }

  return {
    id: "buildings",
    group,
    async init(ctx) {
      const { file, fallback } = await loadBuildings(ctx.mode)
      buildings = file.buildings
      index = indexBuildings(buildings)
      meshes = buildChunks(buildings).map(({ geometry, owner }) => {
        const mesh = new Mesh(geometry, material)
        mesh.userData = { owner }
        mesh.name = "buildings-chunk"
        return mesh
      })
      group.add(...meshes)
      notice = fallback
        ? "buildings: data/buildings.json is missing, showing the fixture (node scripts/fetch-buildings.ts)"
        : null
      showSelection()
    },
    notice: () => notice,
    setLight(light: Light) {
      // By night the facades go dark, so the Lichtplan's lights carry the scene.
      material.color.setScalar(light === "night" ? 0.45 : 1)
    },
    pick(ray: Raycaster) {
      return pickBuilding(ray, meshes, buildings)
    },
    select(id: string | null) {
      const next = parseBuildingSelection(id)
      if (next === selected && (next == null || highlight != null)) return
      selected = next
      showSelection()
    },
  }
}
