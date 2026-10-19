import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  Path,
  Shape,
  ShapeGeometry,
  Vector2,
} from "three"
import { GROUND_OPACITY } from "../constants.ts"
import type { Layer } from "./types.ts"

// The ground: land, water (the Hudson and East River) and the street centrelines.
// Owned by ticket T2 in plan/PLAN.md; scripts/fetch-ground.ts makes the data.

export type GroundBox = { minX: number; maxX: number; minZ: number; maxZ: number }

// Written by scripts/fetch-ground.ts. Every ring and line is flat [x0, z0, x1, z1, ...]
// in metres from the venue (x east, z south).
export type GroundData = {
  source: string
  // The box the land and streets are clipped to: AREA plus a margin.
  box: GroundBox
  // Each polygon is its outer ring followed by its holes. Not closed: the last point
  // does not repeat the first.
  land: number[][][]
  streets: number[][]
}

// Water reaches this far from the venue on every side, past the fog, so its edge is
// never seen.
export const WATER_HALF_SIZE_M = 10_000
// Streets sit just above the land; the land's polygon offset keeps them on top from
// far away too, where 0.4 m is below the depth buffer's resolution.
const STREET_Y = 0.4

const LAND_COLOR = 0x5d6678
const WATER_COLOR = 0x1d5f99
const STREET_COLOR = 0xd4dbe8

// The meshes are built in shape space (x, y) and laid flat by a -90 degree turn about
// x, which sends shape y to world -z. So a local point (x, z) is shape point (x, -z).
export function ringToPoints(ring: number[]): Vector2[] {
  const points: Vector2[] = []
  for (let i = 0; i + 1 < ring.length; i += 2) points.push(new Vector2(ring[i]!, -ring[i + 1]!))
  return points
}

export function landShapes(data: GroundData): Shape[] {
  return data.land.map(([outer, ...holes]) => {
    const shape = new Shape(ringToPoints(outer!))
    shape.holes = holes.map((h) => new Path(ringToPoints(h)))
    return shape
  })
}

// Everything that is not land is water: one large square with every land polygon cut
// out, plus the land's own holes (lakes, basins) filled in. Water and land never
// overlap, so with both at GROUND_OPACITY the subway shows through either one.
export function waterShapes(data: GroundData, halfSize = WATER_HALF_SIZE_M): Shape[] {
  const s = halfSize
  const sea = new Shape([new Vector2(-s, -s), new Vector2(s, -s), new Vector2(s, s), new Vector2(-s, s)])
  sea.holes = data.land.map(([outer]) => new Path(ringToPoints(outer!)))
  const lakes = data.land.flatMap(([, ...holes]) => holes.map((h) => new Shape(ringToPoints(h))))
  return [sea, ...lakes]
}

// One position pair per street segment, for a single LineSegments draw call.
export function streetPositions(streets: number[][], y = STREET_Y): Float32Array {
  let segments = 0
  for (const line of streets) segments += Math.max(0, line.length / 2 - 1)
  const out = new Float32Array(segments * 6)
  let o = 0
  for (const line of streets) {
    for (let i = 2; i + 1 < line.length; i += 2) {
      out[o++] = line[i - 2]!
      out[o++] = y
      out[o++] = line[i - 1]!
      out[o++] = line[i]!
      out[o++] = y
      out[o++] = line[i + 1]!
    }
  }
  return out
}

function flatMesh(shapes: Shape[], color: number): Mesh {
  const mesh = new Mesh(
    new ShapeGeometry(shapes),
    new MeshLambertMaterial({
      color,
      transparent: true,
      opacity: GROUND_OPACITY,
      // Writes no depth, so the subway's see-through copy (src/layers/subway.ts),
      // drawn after the ground, shows through it.
      depthWrite: false,
      // Pushes the ground back in depth, so streets, the venue ring and anything else
      // drawn on it win over it at any distance.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  )
  mesh.rotation.x = -Math.PI / 2
  return mesh
}

export function createGroundLayer(): Layer {
  const group = new Group()
  group.name = "ground"
  let streetCount = 0
  return {
    id: "ground",
    group,
    // The coast and the streets are the same in every mode, so fixture, recorded and
    // live all draw the committed file; it covers the whole area (see fetch-ground.ts).
    async init() {
      const url = `${import.meta.env.BASE_URL}fixtures/ground.json`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
      const data = (await res.json()) as GroundData
      const water = flatMesh(waterShapes(data), WATER_COLOR)
      water.name = "water"
      const land = flatMesh(landShapes(data), LAND_COLOR)
      land.name = "land"
      const geometry = new BufferGeometry()
      geometry.setAttribute("position", new Float32BufferAttribute(streetPositions(data.streets), 3))
      const streets = new LineSegments(geometry, new LineBasicMaterial({ color: STREET_COLOR, transparent: true, opacity: 0.85 }))
      streets.name = "streets"
      // Drawn after the land, so the transparent pass never paints land over them.
      streets.renderOrder = 1
      streetCount = data.streets.length
      group.add(water, land, streets)
    },
    summary: () => (streetCount > 0 ? `${streetCount.toLocaleString("en-US")} street segments` : null),
  }
}
