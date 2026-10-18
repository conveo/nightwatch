import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Raycaster,
} from "three"
import { SUBWAY_DEPTH_M, type AREA } from "../constants.ts"
import { toLocal, type Local } from "../geo.ts"
import type { Layer, LayerContext } from "./types.ts"

// The subway network from the MTA's static GTFS (written by scripts/fetch-subway.ts):
// every line inside AREA as a tube SUBWAY_DEPTH_M below the street in its route
// colour, and the stations as small white markers. Owned by ticket T3 in plan/PLAN.md.
//
// The types and helpers exported here are also how the trains layer (T4) places
// trains: a realtime trip id ends in its GTFS shape id ("…_N..N20R"), every shape
// lists the stations along it with their distance from its start, and pointAlong()
// turns a distance into a position on the line. loadSubwayData() is shared, so both
// layers read the file once.
//
// Selection ids: "route:<route id>" (for example "route:N") highlights a line and
// dims the others; "stop:<station id>" (for example "stop:R22") highlights a station.

export type SubwayRoute = {
  // GTFS route_id: "N", "6X", "GS".
  id: string
  // What riders see on the bullet: "N", "6", "S".
  name: string
  // "#RRGGBB", from route_color (GTFS defaults: white, with black text).
  color: string
  textColor: string
}

export type SubwayStop = {
  // GTFS parent station id ("R22"). Realtime feeds name a platform by this id plus
  // its direction ("R22N", "R22S"); stationId() turns one into the other.
  id: string
  name: string
  lat: number
  lon: number
  // The routes that stop here at some time of day, in the feed's route order.
  routes: string[]
}

export type SubwayShape = {
  // GTFS shape_id ("N..N20R"). One route can have many: directions, branches, short turns.
  id: string
  route: string
  // The line's path as [lat, lon], clipped to the area the file covers.
  points: Array<[number, number]>
  // The stations this shape's trips stop at, in order, with their distance (metres)
  // along `points` from its first point.
  stops: Array<{ id: string; d: number }>
}

export type SubwayData = {
  feed: { publisher: string; version: string; start: string; end: string }
  // What the lines were clipped to: the whole AREA, or a radius around the venue.
  clip: { area: typeof AREA } | { radiusM: number }
  routes: SubwayRoute[]
  shapes: SubwayShape[]
  stops: SubwayStop[]
}

// Fixture mode reads the small committed sample; recorded and live mode read the
// whole area, written by `node scripts/fetch-subway.ts` and served by the dev server.
// The static network does not change with the data time, so both use the same file.
export const SUBWAY_FIXTURE_URL = "/fixtures/subway.json"
export const SUBWAY_DATA_URL = "/data/subway.json"

const loads = new Map<string, Promise<SubwayData>>()

async function fetchSubway(url: string): Promise<SubwayData> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  // The dev server answers a missing file with the app's page, not a 404.
  if (!(res.headers.get("content-type") ?? "").includes("json")) throw new Error(`${url} is missing`)
  return (await res.json()) as SubwayData
}

export function loadSubwayData(ctx: LayerContext): Promise<SubwayData> {
  const url = ctx.mode === "fixture" ? SUBWAY_FIXTURE_URL : SUBWAY_DATA_URL
  let load = loads.get(url)
  if (load == null) {
    load =
      url === SUBWAY_FIXTURE_URL
        ? fetchSubway(url)
        : // Without the downloaded network, draw the sample rather than nothing.
          fetchSubway(url).catch((error: unknown) => {
            console.warn(`subway: ${(error as Error).message}; run scripts/fetch-subway.ts. Using the fixture.`)
            return fetchSubway(SUBWAY_FIXTURE_URL)
          })
    // A failed load is not cached, so the next caller tries again.
    load.catch(() => loads.delete(url))
    loads.set(url, load)
  }
  return load
}

// "R22N" (a platform in a realtime feed) -> "R22" (the station in SubwayData.stops).
export function stationId(stopId: string): string {
  return stopId.replace(/(\d)[NS]$/, "$1")
}

// A line in scene metres, with the distance from its start to each point.
export type Path = { points: Local[]; distances: number[]; length: number }

export function toPath(points: Array<[number, number]>): Path {
  const local = points.map(([lat, lon]) => toLocal({ lat, lon }))
  const distances = [0]
  for (let i = 1; i < local.length; i++) {
    const a = local[i - 1]!
    const b = local[i]!
    distances.push(distances[i - 1]! + Math.hypot(b.x - a.x, b.z - a.z))
  }
  return { points: local, distances, length: distances.at(-1) ?? 0 }
}

// The position at distance `d` along a path (clamped to its ends), and the unit
// direction of travel there: a train's block turns to Math.atan2(dir.x, dir.z).
export function pointAlong(path: Path, d: number): Local & { dir: Local } {
  const { points, distances } = path
  if (points.length === 0) throw new Error("pointAlong: empty path")
  if (points.length === 1) return { ...points[0]!, dir: { x: 0, z: -1 } }
  const t = Math.min(Math.max(d, 0), path.length)
  // The last segment that starts at or before t.
  let lo = 0
  let hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (distances[mid]! <= t) lo = mid
    else hi = mid
  }
  const a = points[lo]!
  const b = points[hi]!
  const len = distances[hi]! - distances[lo]!
  const f = len > 0 ? (t - distances[lo]!) / len : 0
  return {
    x: a.x + (b.x - a.x) * f,
    z: a.z + (b.z - a.z) * f,
    dir: len > 0 ? { x: (b.x - a.x) / len, z: (b.z - a.z) / len } : { x: 0, z: -1 },
  }
}

// The point on a path nearest to `p`: its distance along the path, and how far `p` is from it.
export function project(path: Path, p: Local): { d: number; offset: number } {
  let best = { d: 0, offset: Infinity }
  for (let i = 1; i < path.points.length; i++) {
    const a = path.points[i - 1]!
    const b = path.points[i]!
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len2 = dx * dx + dz * dz
    const f = len2 > 0 ? Math.min(Math.max(((p.x - a.x) * dx + (p.z - a.z) * dz) / len2, 0), 1) : 0
    const offset = Math.hypot(a.x + dx * f - p.x, a.z + dz * f - p.z)
    if (offset < best.offset) best = { d: path.distances[i - 1]! + f * Math.sqrt(len2), offset }
  }
  return best
}

// Many shapes are variants of one line: the other direction a few metres away, short
// turns, branches that share a trunk. Drawing every one would multiply the geometry
// for nothing, so per route a shape is drawn only if more than 5% of it runs where no
// drawn shape does (within about one cell). The longest go first. The data keeps
// every shape; this only decides what is drawn.
export function distinctLines(paths: Path[], cellM = 10): Path[] {
  const covered = new Set<string>()
  const cell = (x: number, z: number) => `${Math.floor(x / cellM)},${Math.floor(z / cellM)}`
  const samples = (path: Path) => {
    const out: Local[] = []
    for (let d = 0; d <= path.length; d += cellM / 2) out.push(pointAlong(path, d))
    return out
  }
  const isCovered = ({ x, z }: Local) => {
    const cx = Math.floor(x / cellM)
    const cz = Math.floor(z / cellM)
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (covered.has(`${cx + i},${cz + j}`)) return true
    return false
  }
  const drawn: Path[] = []
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    if (path.points.length < 2) continue
    const points = samples(path)
    const fresh = points.filter((p) => !isCovered(p)).length
    if (fresh / points.length < 0.05) continue
    drawn.push(path)
    for (const p of points) covered.add(cell(p.x, p.z))
  }
  return drawn
}

// About a two-track tunnel's width, and still a few pixels wide from 3.5 km up.
export const TUBE_RADIUS_M = 5
const TUBE_SIDES = 8

// Tubes along level polylines, one ring of vertices per point. Unlike TubeGeometry,
// which samples a curve evenly, this follows the GTFS points exactly, with far fewer
// vertices. Lines run level, so each ring is built around the horizontal normal and
// widened at bends (a mitre) so the tube keeps its width through a turn.
export function tubeGeometry(lines: Local[][], y: number, radius = TUBE_RADIUS_M, sides = TUBE_SIDES): BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  for (const line of lines) {
    // Repeated points have no direction; drop each one that sits on the last kept point.
    const points: Local[] = []
    for (const p of line) {
      const last = points.at(-1)
      if (last == null || Math.hypot(p.x - last.x, p.z - last.z) > 0.01) points.push(p)
    }
    if (points.length < 2) continue
    const base = positions.length / 3
    for (let i = 0; i < points.length; i++) {
      const into = unit(points[Math.max(i - 1, 0)]!, points[Math.max(i, 1)]!)
      const out = unit(points[Math.min(i, points.length - 2)]!, points[Math.min(i + 1, points.length - 1)]!)
      let tx = into.x + out.x
      let tz = into.z + out.z
      const tl = Math.hypot(tx, tz)
      // A full reversal has no bisector; keep the incoming direction.
      if (tl < 1e-6) [tx, tz] = [into.x, into.z]
      else [tx, tz] = [tx / tl, tz / tl]
      const mitre = Math.min(1 / Math.max(tx * out.x + tz * out.z, 1e-6), 2)
      // Horizontal normal (-tz, 0, tx) and up (0, 1, 0) span the ring.
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2
        const nx = -tz * Math.cos(a)
        const ny = Math.sin(a)
        const nz = tx * Math.cos(a)
        positions.push(points[i]!.x + nx * radius * mitre, y + ny * radius, points[i]!.z + nz * radius * mitre)
        normals.push(nx, ny, nz)
      }
    }
    for (let i = 0; i < points.length - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const a = base + i * sides + s
        const b = base + i * sides + ((s + 1) % sides)
        const c = a + sides
        const d = b + sides
        indices.push(a, c, b, b, c, d)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

function unit(a: Local, b: Local): Local {
  const len = Math.hypot(b.x - a.x, b.z - a.z)
  return len > 0 ? { x: (b.x - a.x) / len, z: (b.z - a.z) / len } : { x: 0, z: -1 }
}

const STATION_RADIUS_M = 10
const STATION_HEIGHT_M = 10
const STATION_COLOR = 0xf4f6fb
const SELECTED_STATION_COLOR = 0xffd60a

export function createSubwayLayer(load: (ctx: LayerContext) => Promise<SubwayData> = loadSubwayData): Layer {
  const group = new Group()
  group.name = "subway"
  const lines = new Map<string, Mesh<BufferGeometry, MeshStandardMaterial>>()
  let stations: InstancedMesh<CylinderGeometry, MeshStandardMaterial> | null = null
  let stops: SubwayStop[] = []
  const names = new Set<string>()

  function lineMaterial(color: string): MeshStandardMaterial {
    // The lines glow a little in their own colour, so they read through the
    // half-transparent ground and at night.
    return new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, roughness: 0.55 })
  }

  return {
    id: "subway",
    group,
    async init(ctx) {
      const data = await load(ctx)
      const byRoute = new Map<string, SubwayShape[]>()
      for (const shape of data.shapes) byRoute.set(shape.route, [...(byRoute.get(shape.route) ?? []), shape])
      for (const route of data.routes) {
        const shapes = byRoute.get(route.id)
        if (shapes == null) continue
        const paths = distinctLines(shapes.map((s) => toPath(s.points)))
        const mesh = new Mesh(
          tubeGeometry(
            paths.map((p) => p.points),
            SUBWAY_DEPTH_M,
          ),
          lineMaterial(route.color),
        )
        mesh.name = `route:${route.id}`
        mesh.userData = { route: route.id }
        lines.set(route.id, mesh)
        group.add(mesh)
        // The diamond expresses (6X, 7X, FX) are the same line on a map.
        names.add(route.name.replace(/(.)X$/, "$1"))
      }

      stops = data.stops
      stations = new InstancedMesh(
        new CylinderGeometry(STATION_RADIUS_M, STATION_RADIUS_M, STATION_HEIGHT_M, 20),
        new MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.4 }),
        Math.max(stops.length, 1),
      )
      stations.count = stops.length
      stations.name = "stations"
      const m = new Matrix4()
      stops.forEach((stop, i) => {
        const { x, z } = toLocal(stop)
        // Centred a little above the tubes, so the marker wraps the lines it serves.
        stations!.setMatrixAt(i, m.makeTranslation(x, SUBWAY_DEPTH_M + 1, z))
        stations!.setColorAt(i, new Color(STATION_COLOR))
      })
      group.add(stations)
    },
    summary() {
      if (lines.size === 0) return null
      return `${names.size} subway lines · ${stops.length} stations`
    },
    pick(ray: Raycaster) {
      if (stations != null) {
        const hit = ray.intersectObject(stations, false)[0]
        if (hit?.instanceId != null) return `stop:${stops[hit.instanceId]!.id}`
      }
      const hit = ray.intersectObjects([...lines.values()], false)[0]
      return hit == null ? null : `route:${hit.object.userData.route as string}`
    },
    select(id) {
      const route = id?.startsWith("route:") ? id.slice("route:".length) : null
      const highlight = route != null && lines.has(route)
      for (const [rid, mesh] of lines) {
        const dim = highlight && rid !== route
        mesh.material.transparent = dim
        mesh.material.opacity = dim ? 0.2 : 1
        mesh.material.emissiveIntensity = highlight && rid === route ? 0.9 : 0.45
        mesh.material.needsUpdate = true
      }
      if (stations != null) {
        const stop = id?.startsWith("stop:") ? id.slice("stop:".length) : null
        const m = new Matrix4()
        stops.forEach((s, i) => {
          const selected = s.id === stop
          const { x, z } = toLocal(s)
          const scale = selected ? 1.8 : 1
          stations!.setMatrixAt(i, m.makeScale(scale, scale, scale).setPosition(x, SUBWAY_DEPTH_M + 1, z))
          stations!.setColorAt(i, new Color(selected ? SELECTED_STATION_COLOR : STATION_COLOR))
        })
        stations.instanceMatrix.needsUpdate = true
        if (stations.instanceColor != null) stations.instanceColor.needsUpdate = true
        // Picking tests the cached bounds first; a grown marker must still be hit.
        stations.computeBoundingSphere()
      }
    },
  }
}
