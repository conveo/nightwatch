import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShapeUtils,
  Vector2,
  type Raycaster,
} from "three"
import { VENUE, type LatLon } from "../geo.ts"
import type { Layer } from "./types.ts"

// Lower Manhattan's buildings, extruded from NYC Open Data footprints and roof heights
// (scripts/fetch-buildings.ts). Fixture mode draws the small committed sample around
// the venue; recorded and live mode draw the full download in data/, or the fixture
// when nothing has been downloaded.

// A ring is a flat [x0, z0, x1, z1, ...] in metres from the venue, not closed. A
// footprint is an outer ring followed by its holes; a building can have several.
export type Ring = number[]
export type Footprint = Ring[]
export type Building = { bin: string; h: number; p: Footprint[] }
export type BuildingsFile = { source: string; origin: LatLon; buildings: Building[] }

const FIXTURE_URL = "fixtures/buildings.json"
const DATA_URL = "data/buildings.json"

// The buildings are merged into one mesh per tile this size: a few draw calls for the
// whole area, and a click only tests the triangles of the tiles its ray passes near.
const TILE_M = 1500

// Colour by height on a log scale, from deep blue walk-ups to pale towers. The venue
// is warm, next to its red pin; a selected building is bright amber.
const RAMP = [0x2b3a63, 0x3a6aa6, 0x5aa6d8, 0xc8ecff].map((hex) => new Color(hex))
const RAMP_LOW_M = 10
const RAMP_HIGH_M = 200
const VENUE_COLOR = new Color(0xff8a65)
const SELECTED_COLOR = new Color(0xffc21a)

export function heightColor(h: number, out = new Color()): Color {
  const t = Math.log(h / RAMP_LOW_M) / Math.log(RAMP_HIGH_M / RAMP_LOW_M)
  const s = Math.min(Math.max(t, 0), 1) * (RAMP.length - 1)
  const i = Math.min(Math.floor(s), RAMP.length - 2)
  return out.copy(RAMP[i]!).lerp(RAMP[i + 1]!, s - i)
}

// `sel` names a building as "bin:<BIN>".
export function binOf(sel: string | null): string | null {
  return sel != null && sel.startsWith("bin:") && sel.length > 4 ? sel.slice(4) : null
}

export function indexByBin(buildings: Building[]): Map<string, number[]> {
  const index = new Map<string, number[]>()
  buildings.forEach((b, i) => {
    const list = index.get(b.bin)
    if (list == null) index.set(b.bin, [i])
    else list.push(i)
  })
  return index
}

function toPoints(ring: Ring): Vector2[] {
  const points: Vector2[] = []
  for (let i = 0; i < ring.length; i += 2) points.push(new Vector2(ring[i], ring[i + 1]))
  return points
}

// Extrude the given buildings into one geometry: a flat roof and a wall per edge,
// coloured by colorOf. `owners` maps each triangle to its building's index, for pick.
export function extrude(
  buildings: Building[],
  indices: Iterable<number>,
  colorOf: (b: Building) => Color,
): { geometry: BufferGeometry; owners: Uint32Array } {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const index: number[] = []
  const owners: number[] = []
  const vertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Color) => {
    positions.push(x, y, z)
    normals.push(nx, ny, nz)
    colors.push(c.r, c.g, c.b)
  }
  for (const i of indices) {
    const b = buildings[i]!
    const color = colorOf(b)
    for (const footprint of b.p) {
      const [outer, ...holes] = footprint.map(toPoints)
      if (outer == null || outer.length < 3) continue
      // Outer rings counter-clockwise and holes clockwise in (x, z), so a wall's
      // outward side is always the same side of its edge.
      if (ShapeUtils.isClockWise(outer)) outer.reverse()
      for (const hole of holes) if (!ShapeUtils.isClockWise(hole)) hole.reverse()
      const rings = [outer, ...holes]
      const points = rings.flat()

      const roof = positions.length / 3
      for (const p of points) vertex(p.x, b.h, p.y, 0, 1, 0, color)
      for (const [a, c, d] of ShapeUtils.triangulateShape(outer, holes) as [number, number, number][]) {
        const pa = points[a]!
        const pc = points[c]!
        const pd = points[d]!
        // Wind each roof triangle to face up.
        const up = (pc.y - pa.y) * (pd.x - pa.x) - (pc.x - pa.x) * (pd.y - pa.y) > 0
        index.push(roof + a, roof + (up ? c : d), roof + (up ? d : c))
        owners.push(i)
      }

      for (const ring of rings) {
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k]!
          const c = ring[(k + 1) % ring.length]!
          const dx = c.x - a.x
          const dz = c.y - a.y
          const len = Math.hypot(dx, dz)
          if (len === 0) continue
          const v = positions.length / 3
          vertex(a.x, 0, a.y, dz / len, 0, -dx / len, color)
          vertex(c.x, 0, c.y, dz / len, 0, -dx / len, color)
          vertex(a.x, b.h, a.y, dz / len, 0, -dx / len, color)
          vertex(c.x, b.h, c.y, dz / len, 0, -dx / len, color)
          index.push(v, v + 3, v + 1, v, v + 2, v + 3)
          owners.push(i, i)
        }
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3))
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3))
  geometry.setIndex(new BufferAttribute(new Uint32Array(index), 1))
  geometry.computeBoundingSphere()
  return { geometry, owners: Uint32Array.from(owners) }
}

async function fetchBuildings(url: string): Promise<BuildingsFile | null> {
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  // The dev server answers a missing file with the app's page, so check the type too.
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null
  return (await res.json()) as BuildingsFile
}

// `load` is replaceable so tests can feed the layer a file from disk.
export function createBuildingsLayer(load: (url: string) => Promise<BuildingsFile | null> = fetchBuildings): Layer {
  const group = new Group()
  group.name = "buildings"
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 })
  // Drawn over the selected building's own faces, so pulled slightly towards the camera.
  const selectedMaterial = new MeshStandardMaterial({
    vertexColors: true,
    emissive: SELECTED_COLOR,
    emissiveIntensity: 0.5,
    roughness: 0.6,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  const selection = new Mesh(new BufferGeometry(), selectedMaterial)
  selection.name = "buildings-selection"
  // The same building again, faint and drawn through everything in front of it, so a
  // selection behind a taller building still shows from any view.
  const xray = new Mesh(
    selection.geometry,
    new MeshBasicMaterial({ color: SELECTED_COLOR, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false }),
  )
  xray.renderOrder = 1
  selection.add(xray)
  selection.visible = false
  group.add(selection)

  let buildings: Building[] = []
  let byBin = new Map<string, number[]>()
  let tiles: Mesh[] = []
  let fallback = false
  let selected: string | null = null

  function showSelection(): void {
    const bin = binOf(selected)
    const hits = bin == null ? undefined : byBin.get(bin)
    selection.geometry.dispose()
    selection.geometry = hits == null ? new BufferGeometry() : extrude(buildings, hits, () => SELECTED_COLOR).geometry
    xray.geometry = selection.geometry
    selection.visible = hits != null
  }

  return {
    id: "buildings",
    group,
    async init(ctx) {
      const started = performance.now()
      // A full download that fails to load falls back to the fixture like a missing one.
      let file = ctx.mode === "fixture" ? null : await load(DATA_URL).catch(() => null)
      fallback = ctx.mode !== "fixture" && file == null
      file ??= await load(FIXTURE_URL)
      if (file == null) throw new Error(`could not load ${FIXTURE_URL}`)
      buildings = file.buildings
      byBin = indexByBin(buildings)

      const byTile = new Map<string, number[]>()
      buildings.forEach((b, i) => {
        const [x = 0, z = 0] = b.p[0]?.[0] ?? []
        const key = `${Math.floor(x / TILE_M)},${Math.floor(z / TILE_M)}`
        const list = byTile.get(key)
        if (list == null) byTile.set(key, [i])
        else list.push(i)
      })
      const color = new Color()
      tiles = [...byTile.values()].map((indices) => {
        const { geometry, owners } = extrude(buildings, indices, (b) =>
          b.bin === VENUE.bin ? VENUE_COLOR : heightColor(b.h, color),
        )
        const mesh = new Mesh(geometry, material)
        mesh.userData.owners = owners
        return mesh
      })
      group.add(...tiles)
      showSelection()
      console.info(`buildings: ${buildings.length} in ${tiles.length} meshes, ${Math.round(performance.now() - started)} ms`)
    },
    summary: () => (buildings.length === 0 ? null : fallback ? "buildings: fixture only" : ""),
    pick(ray: Raycaster) {
      const hit = ray.intersectObjects(tiles, false)[0]
      if (hit?.faceIndex == null) return null
      const owner = (hit.object.userData.owners as Uint32Array)[hit.faceIndex]
      return owner == null ? null : `bin:${buildings[owner]!.bin}`
    },
    select(id) {
      selected = id
      showSelection()
    },
  }
}
