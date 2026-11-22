// Downloads the centre's buildings with their heights, for the buildings layer (T1).
//
//   node scripts/fetch-buildings.ts            # writes data/buildings.json and the fixture
//   node scripts/fetch-buildings.ts --refresh  # downloads again instead of reusing data/raw/
//
// Footprints: GRB building outlines (GRB:GBG) from Digitaal Vlaanderen's WFS, requested
// twice for the same area: in EPSG:4326 to draw them, and in EPSG:31370 (Belgian
// Lambert 72) to sample heights. The server reprojects both, so this script has no
// projection code; the two answers are joined on the GRB object id, OIDN.
//
// Heights: the DHMV II elevation model (1 m) from the same service's WCS. A building's
// height is the 90th percentile of surface (DSM) minus terrain (DTM) over the cells
// whose centres lie inside its footprint. The rasters come in 500 m tiles, a few
// requests for the whole area, not one per building.
//
// Towers: a church is often a single GRB polygon, nave and tower together, so one
// height per footprint either flattens the tower into the nave or lifts the whole
// nave to the tower's height. Where the surface inside a footprint rises far above
// the footprint's median, the tall cells are drawn as a separate part (outline and
// height of their own) on top of the body, under the same OIDN.
//
// Data: Digitaal Vlaanderen, Modellicentie Gratis Hergebruik v1.0.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { AREA, FIXTURE_RADIUS_M, inArea } from "../src/constants.ts"
import { toLatLon, toLocal } from "../src/geo.ts"
import type { BuildingRecord, BuildingsFile, Polygon, Ring } from "../src/layers/buildings.ts"

const WFS = "https://geo.api.vlaanderen.be/GRB/wfs"
const WCS = "https://geo.api.vlaanderen.be/DHMV/wcs"
const TILE_M = 500
const NODATA = -9999

// ---------------------------------------------------------------------------------
// The file format is defined by the layer that reads it, src/layers/buildings.ts.

export const SOURCE =
  "GRB (GRB:GBG) and DHMV II (DSM minus DTM, 1 m), Digitaal Vlaanderen, Modellicentie Gratis Hergebruik v1.0"

// ---------------------------------------------------------------------------------
// Footprints

type Position = number[]
export type Geometry =
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] }

type Feature = { geometry: Geometry | null; properties: { OIDN: number } }

const round1 = (n: number): number => Math.round(n * 10) / 10

function polygonsOf(geometry: Geometry): Position[][][] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates
}

// Twice the signed area of a flat ring in (x, z). Positive is clockwise seen from
// above (x east, z south), so the layer can orient walls without guessing.
export function ringArea2(ring: Ring): number {
  let sum = 0
  const n = ring.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    sum += ring[2 * i]! * ring[2 * j + 1]! - ring[2 * j]! * ring[2 * i + 1]!
  }
  return sum
}

// A GeoJSON ring in degrees ([lon, lat]) to a flat ring in scene metres, rounded to
// 0.1 m: the closing point and points that round onto their neighbour are dropped.
// Returns null when fewer than three points are left.
export function ringToLocal(ring: Position[]): Ring | null {
  const out: number[] = []
  for (const [lon, lat] of ring) {
    const { x, z } = toLocal({ lat: lat!, lon: lon! })
    const rx = round1(x)
    const rz = round1(z) + 0 // no -0 in the file
    const n = out.length
    if (n >= 2 && out[n - 2] === rx && out[n - 1] === rz) continue
    out.push(rx, rz)
  }
  while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2
  return out.length >= 6 ? out : null
}

// A footprint in degrees to scene metres: outer rings clockwise seen from above
// (positive ringArea2), holes the other way. Degenerate rings are dropped.
export function footprintToLocal(geometry: Geometry): Polygon[] {
  const polygons: Polygon[] = []
  for (const [outerRing, ...holeRings] of polygonsOf(geometry)) {
    const outer = outerRing == null ? null : ringToLocal(outerRing)
    if (outer == null) continue
    if (ringArea2(outer) < 0) reverseRing(outer)
    const local: Polygon = [outer]
    for (const ring of holeRings) {
      const hole = ringToLocal(ring)
      if (hole == null) continue
      if (ringArea2(hole) > 0) reverseRing(hole)
      local.push(hole)
    }
    polygons.push(local)
  }
  return polygons
}

function reverseRing(ring: Ring): void {
  const n = ring.length / 2
  for (let i = 0; i < n / 2; i++) {
    const j = n - 1 - i
    const x = ring[2 * i]!
    const z = ring[2 * i + 1]!
    ring[2 * i] = ring[2 * j]!
    ring[2 * i + 1] = ring[2 * j + 1]!
    ring[2 * j] = x
    ring[2 * j + 1] = z
  }
}

// ---------------------------------------------------------------------------------
// Height sampling

// A raster in Lambert 72: (x0, y0) is the top-left corner of the top-left cell, cells
// are `size` metres, rows run from north to south.
export type Raster = { x0: number; y0: number; width: number; height: number; size: number; values: Float32Array }

export type Cell = { col: number; row: number; h: number }

function insideRings(x: number, y: number, rings: Position[][]): boolean {
  // Even-odd over every ring, so holes are outside.
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!
      const [xj, yj] = ring[j]!
      if (yi! > y !== yj! > y && x < ((xj! - xi!) * (y - yi!)) / (yj! - yi!) + xi!) inside = !inside
    }
  }
  return inside
}

// Surface minus terrain for every cell whose centre lies inside the footprint (in
// Lambert 72). A footprint too small to hold a cell centre gets the cell under its
// first vertex. Cells without data in either raster are skipped.
export function sampleFootprint(dsm: Raster, dtm: Raster, geometry: Geometry): Cell[] {
  const polygons = polygonsOf(geometry)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const rings of polygons)
    for (const [x, y] of rings[0] ?? []) {
      minX = Math.min(minX, x!)
      maxX = Math.max(maxX, x!)
      minY = Math.min(minY, y!)
      maxY = Math.max(maxY, y!)
    }
  const cells: Cell[] = []
  const c0 = Math.max(0, Math.floor((minX - dsm.x0) / dsm.size))
  const c1 = Math.min(dsm.width - 1, Math.floor((maxX - dsm.x0) / dsm.size))
  const r0 = Math.max(0, Math.floor((dsm.y0 - maxY) / dsm.size))
  const r1 = Math.min(dsm.height - 1, Math.floor((dsm.y0 - minY) / dsm.size))
  for (let row = r0; row <= r1; row++) {
    const y = dsm.y0 - (row + 0.5) * dsm.size
    for (let col = c0; col <= c1; col++) {
      const x = dsm.x0 + (col + 0.5) * dsm.size
      if (!polygons.some((rings) => insideRings(x, y, rings))) continue
      const h = heightAt(dsm, dtm, col, row)
      if (h != null) cells.push({ col, row, h })
    }
  }
  if (cells.length === 0 && Number.isFinite(minX)) {
    const [x, y] = polygons[0]![0]![0]!
    const col = Math.floor((x! - dsm.x0) / dsm.size)
    const row = Math.floor((dsm.y0 - y!) / dsm.size)
    const h = heightAt(dsm, dtm, col, row)
    if (h != null) cells.push({ col, row, h })
  }
  return cells
}

function heightAt(dsm: Raster, dtm: Raster, col: number, row: number): number | null {
  if (col < 0 || row < 0 || col >= dsm.width || row >= dsm.height) return null
  const x = dsm.x0 + (col + 0.5) * dsm.size
  const y = dsm.y0 - (row + 0.5) * dsm.size
  const tc = Math.floor((x - dtm.x0) / dtm.size)
  const tr = Math.floor((dtm.y0 - y) / dtm.size)
  if (tc < 0 || tr < 0 || tc >= dtm.width || tr >= dtm.height) return null
  const s = dsm.values[row * dsm.width + col]!
  const t = dtm.values[tr * dtm.width + tc]!
  if (!Number.isFinite(s) || !Number.isFinite(t) || s <= NODATA || t <= NODATA) return null
  return Math.max(0, s - t)
}

// The p-th percentile (0 to 100) by linear interpolation; NaN for no values.
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo)
}

export const HEIGHT_PERCENTILE = 90

// A tall part: at least this many cells (m²) well above the rest of the footprint.
const TOWER_MIN_CELLS = 12
// The surface must rise this far above the footprint's median to count as a tower.
const TOWER_MIN_RISE_M = 20
// A tower's shaft is drawn to this percentile of its cells; a spire tops it when
// the highest cells rise more than SPIRE_MIN_M above that.
const SHAFT_PERCENTILE = 75
const SPIRE_PERCENTILE = 99.5
const SPIRE_MIN_M = 10

export type Tower = { h: number; s?: number; cells: Cell[] }
export type Split = { body: number; towers: Tower[] }

const key = (col: number, row: number): string => `${col},${row}`
const N4: ReadonlyArray<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const N8: ReadonlyArray<[number, number]> = [...N4, [1, 1], [1, -1], [-1, 1], [-1, -1]]

// One height for the body, plus the tall parts (towers) when the footprint mixes a
// tower and a lower body. A cell is tall when it rises more than halfway from the
// footprint's median to its top (98th percentile). An opening (keep the tall cells
// whose four neighbours are tall too, then grow them back by one cell) drops strips
// one or two cells wide, such as a tree along a wall; each connected group left is
// one tower. The body's height then comes from the cells outside the towers.
export function splitHeights(cells: readonly Cell[]): Split {
  const all = cells.map((c) => c.h)
  const median = percentile(all, 50)
  const top = percentile(all, 98)
  const plain = { body: percentile(all, HEIGHT_PERCENTILE), towers: [] }
  if (cells.length < TOWER_MIN_CELLS * 3 || top - median < TOWER_MIN_RISE_M) return plain
  const threshold = median + (top - median) / 2
  const tall = new Map<string, Cell>()
  for (const c of cells) if (c.h > threshold) tall.set(key(c.col, c.row), c)
  const core = new Set<string>()
  for (const c of tall.values())
    if (N4.every(([dc, dr]) => tall.has(key(c.col + dc, c.row + dr)))) core.add(key(c.col, c.row))
  const opened = new Map<string, Cell>()
  for (const [k, c] of tall)
    if (core.has(k) || N8.some(([dc, dr]) => core.has(key(c.col + dc, c.row + dr)))) opened.set(k, c)
  const towers: Tower[] = []
  const seen = new Set<string>()
  for (const [k, start] of opened) {
    if (seen.has(k)) continue
    seen.add(k)
    const component: Cell[] = []
    const queue = [start]
    while (queue.length > 0) {
      const c = queue.pop()!
      component.push(c)
      for (const [dc, dr] of N8) {
        const nk = key(c.col + dc, c.row + dr)
        const next = opened.get(nk)
        if (next != null && !seen.has(nk)) {
          seen.add(nk)
          queue.push(next)
        }
      }
    }
    if (component.length < TOWER_MIN_CELLS) continue
    const hs = component.map((c) => c.h)
    const h = percentile(hs, SHAFT_PERCENTILE)
    const s = percentile(hs, SPIRE_PERCENTILE)
    towers.push(s - h > SPIRE_MIN_M ? { h, s, cells: component } : { h, cells: component })
  }
  if (towers.length === 0) return plain
  const inTower = new Set(towers.flatMap((t) => t.cells.map((c) => key(c.col, c.row))))
  const rest = cells.filter((c) => !inTower.has(key(c.col, c.row))).map((c) => c.h)
  return { body: rest.length > 0 ? percentile(rest, HEIGHT_PERCENTILE) : median, towers }
}

// The highest point of a building: its body, a tower's shaft or a spire's tip.
export function topOf(b: Pick<BuildingRecord, "h" | "t">): number {
  return Math.max(b.h, ...(b.t ?? []).map((t) => t.s ?? t.h))
}

// The convex hull of a tower's cells (their corners), in Lambert 72, counter-clockwise.
export function cellHull(raster: Raster, cells: readonly Cell[]): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  for (const { col, row } of cells) {
    const x = raster.x0 + col * raster.size
    const y = raster.y0 - row * raster.size
    pts.push([x, y], [x + raster.size, y], [x, y - raster.size], [x + raster.size, y - raster.size])
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Array<[number, number]> = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Array<[number, number]> = []
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

// ---------------------------------------------------------------------------------
// From Lambert 72 to scene metres, without projection code: an affine map fitted by
// least squares to the vertex pairs of the joined footprints (the server reprojected
// the same outlines both ways). Over 1.5 km the residual is a few centimetres.

export type Affine = [number, number, number, number, number, number] // x = a*X + b*Y + c, z = d*X + e*Y + f

export function fitAffine(pairs: ReadonlyArray<{ from: [number, number]; to: [number, number] }>): Affine {
  // Centre the inputs for a well-conditioned 3x3 system.
  const n = pairs.length
  let mx = 0
  let my = 0
  for (const { from } of pairs) {
    mx += from[0] / n
    my += from[1] / n
  }
  let sxx = 0
  let sxy = 0
  let syy = 0
  const bx = [0, 0, 0]
  const bz = [0, 0, 0]
  for (const { from, to } of pairs) {
    const X = from[0] - mx
    const Y = from[1] - my
    sxx += X * X
    sxy += X * Y
    syy += Y * Y
    bx[0]! += X * to[0]
    bx[1]! += Y * to[0]
    bx[2]! += to[0]
    bz[0]! += X * to[1]
    bz[1]! += Y * to[1]
    bz[2]! += to[1]
  }
  const det = sxx * syy - sxy * sxy
  const solve = (b: number[]): [number, number, number] => {
    const a = (b[0]! * syy - b[1]! * sxy) / det
    const e = (b[1]! * sxx - b[0]! * sxy) / det
    const c = b[2]! / n - a * mx - e * my
    return [a, e, c]
  }
  const [a, b, c] = solve(bx)
  const [d, e, f] = solve(bz)
  return [a, b, c, d, e, f]
}

export function applyAffine(m: Affine, X: number, Y: number): [number, number] {
  return [m[0] * X + m[1] * Y + m[2], m[3] * X + m[4] * Y + m[5]]
}

// ---------------------------------------------------------------------------------
// The WCS answers with a GeoTIFF, possibly wrapped in multipart/related.

export function extractTiff(body: Uint8Array, contentType: string): Uint8Array {
  if (!/multipart\//i.test(contentType)) return body
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1]
  if (boundary == null) throw new Error(`multipart answer without a boundary: ${contentType}`)
  const text = Buffer.from(body).toString("latin1")
  const parts = text.split(`--${boundary}`)
  let offset = 0
  for (const part of parts) {
    const start = offset
    offset += part.length + boundary.length + 2
    const headerEnd = part.search(/\r?\n\r?\n/)
    if (headerEnd < 0 || !/content-type:\s*image\/tiff/i.test(part.slice(0, headerEnd))) continue
    const sep = /\r?\n\r?\n/.exec(part.slice(headerEnd))![0].length
    let end = part.length
    if (part.endsWith("\r\n")) end -= 2
    else if (part.endsWith("\n")) end -= 1
    return body.subarray(start + headerEnd + sep, start + end)
  }
  throw new Error("multipart answer without an image/tiff part")
}

// ---------------------------------------------------------------------------------
// Output

export function centroid(polygons: readonly Polygon[]): { x: number; z: number } {
  let x = 0
  let z = 0
  let n = 0
  for (const polygon of polygons) {
    const ring = polygon[0]!
    for (let i = 0; i < ring.length; i += 2) {
      x += ring[i]!
      z += ring[i + 1]!
      n++
    }
  }
  return { x: x / n, z: z / n }
}

export function fixtureOf(buildings: readonly BuildingRecord[], radius = FIXTURE_RADIUS_M): BuildingRecord[] {
  return buildings.filter((b) => {
    const c = centroid(b.p)
    return Math.hypot(c.x, c.z) <= radius
  })
}

// ---------------------------------------------------------------------------------
// Main

async function fetchBytes(url: string): Promise<{ body: Uint8Array; contentType: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return { body: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "" }
    } catch (error) {
      if (attempt >= 3) throw new Error(`${url}: ${(error as Error).message}`)
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
}

async function cached(path: string, refresh: boolean, load: () => Promise<Uint8Array>): Promise<Uint8Array> {
  if (!refresh && existsSync(path)) return new Uint8Array(readFileSync(path))
  const body = await load()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return body
}

// The service's paging (startIndex) skips features, so each request asks for one
// whole box; a box that fills the page is split in four instead. Footprints that
// touch two boxes come back twice and are kept once.
const WFS_PAGE = 10_000

type Box = { south: number; west: number; north: number; east: number }

export async function footprints(srs: "EPSG:4326" | "EPSG:31370", raw: string, refresh: boolean): Promise<Feature[]> {
  const byId = new Map<number, Feature>()
  const queue: Box[] = [AREA]
  while (queue.length > 0) {
    const box = queue.shift()!
    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: "GRB:GBG",
      outputFormat: "application/json",
      srsName: srs,
      bbox: `${box.south},${box.west},${box.north},${box.east},urn:ogc:def:crs:EPSG::4326`,
      count: String(WFS_PAGE),
    })
    const file = join(raw, `gbg-${srs.replace(":", "")}-${box.south}-${box.west}-${box.north}-${box.east}.json`)
    const body = await cached(file, refresh, async () => (await fetchBytes(`${WFS}?${params}`)).body)
    const page = JSON.parse(Buffer.from(body).toString("utf8")) as { features: Feature[] }
    if (page.features.length >= WFS_PAGE) {
      const lat = (box.south + box.north) / 2
      const lon = (box.west + box.east) / 2
      queue.push(
        { south: box.south, west: box.west, north: lat, east: lon },
        { south: box.south, west: lon, north: lat, east: box.east },
        { south: lat, west: box.west, north: box.north, east: lon },
        { south: lat, west: lon, north: box.north, east: box.east },
      )
      continue
    }
    for (const f of page.features) byId.set(f.properties.OIDN, f)
  }
  return [...byId.values()]
}

async function raster(coverage: string, x0: number, y0: number, x1: number, y1: number, raw: string, refresh: boolean) {
  const { fromArrayBuffer } = await import("geotiff")
  const url = `${WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${coverage}&format=image/tiff&subset=x(${x0},${x1})&subset=y(${y0},${y1})`
  const file = join(raw, `${coverage}-${x0}-${y0}.tif`)
  const tif = await cached(file, refresh, async () => {
    const { body, contentType } = await fetchBytes(url)
    return extractTiff(body, contentType)
  })
  const image = await (await fromArrayBuffer(tif.buffer.slice(tif.byteOffset, tif.byteOffset + tif.byteLength) as ArrayBuffer)).getImage()
  const [ox, oy] = image.getOrigin()
  const [rx] = image.getResolution()
  const values = (await image.readRasters({ interleave: true })) as unknown as Float32Array
  return { x0: ox!, y0: oy!, width: image.getWidth(), height: image.getHeight(), size: rx!, values: Float32Array.from(values) }
}

export async function mosaic(coverage: string, x0: number, y0: number, x1: number, y1: number, raw: string, refresh: boolean): Promise<Raster> {
  const out: Raster = { x0, y0: y1, width: x1 - x0, height: y1 - y0, size: 1, values: new Float32Array((x1 - x0) * (y1 - y0)).fill(Number.NaN) }
  for (let tx = x0; tx < x1; tx += TILE_M)
    for (let ty = y0; ty < y1; ty += TILE_M) {
      const tile = await raster(coverage, tx, ty, Math.min(tx + TILE_M, x1), Math.min(ty + TILE_M, y1), raw, refresh)
      if (tile.size !== 1) throw new Error(`${coverage}: expected 1 m cells, got ${tile.size}`)
      const dc = Math.round(tile.x0 - out.x0)
      const dr = Math.round(out.y0 - tile.y0)
      for (let r = 0; r < tile.height; r++) {
        const row = dr + r
        if (row < 0 || row >= out.height) continue
        for (let c = 0; c < tile.width; c++) {
          const col = dc + c
          if (col >= 0 && col < out.width) out.values[row * out.width + col] = tile.values[r * tile.width + c]!
        }
      }
      process.stdout.write(".")
    }
  return out
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { refresh: { type: "boolean", default: false } } })
  const root = fileURLToPath(new URL("..", import.meta.url))
  const raw = join(root, "data", "raw")
  const refresh = values.refresh

  console.log("footprints (GRB:GBG, EPSG:4326 and EPSG:31370)…")
  const [wgs, lambert] = await Promise.all([
    footprints("EPSG:4326", raw, refresh),
    footprints("EPSG:31370", raw, refresh),
  ])
  const byId = new Map(lambert.filter((f) => f.geometry != null).map((f) => [f.properties.OIDN, f.geometry!]))
  console.log(`  ${wgs.length} in EPSG:4326, ${lambert.length} in EPSG:31370`)

  // The join, and the vertex pairs for the Lambert-to-scene fit.
  const joined: { id: number; wgs: Geometry; lambert: Geometry; local: Polygon[] }[] = []
  const pairs: { from: [number, number]; to: [number, number] }[] = []
  for (const f of wgs) {
    if (f.geometry == null) continue
    const l = byId.get(f.properties.OIDN)
    if (l == null) continue
    const local = footprintToLocal(f.geometry)
    if (local.length === 0) continue
    // The WFS returns every footprint that touches the area; keep those centred in it.
    if (!inArea(toLatLon(centroid(local)))) continue
    joined.push({ id: f.properties.OIDN, wgs: f.geometry, lambert: l, local })
    const a = polygonsOf(f.geometry)[0]![0]!
    const b = polygonsOf(l)[0]![0]!
    if (a.length === b.length && pairs.length < 20000)
      a.forEach(([lon, lat], i) => {
        const { x, z } = toLocal({ lat: lat!, lon: lon! })
        pairs.push({ from: [b[i]![0]!, b[i]![1]!], to: [x, z] })
      })
  }
  const affine = fitAffine(pairs)
  const residual = Math.max(
    ...pairs.map(({ from, to }) => {
      const [x, z] = applyAffine(affine, from[0], from[1])
      return Math.hypot(x - to[0], z - to[1])
    }),
  )
  console.log(`  ${joined.length} joined on OIDN; Lambert-to-scene fit over ${pairs.length} vertices, max residual ${residual.toFixed(3)} m`)
  if (residual > 0.5) throw new Error("the two footprint answers do not line up; is the join on OIDN right?")

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const j of joined)
    for (const rings of polygonsOf(j.lambert))
      for (const [x, y] of rings[0]!) {
        minX = Math.min(minX, x!)
        maxX = Math.max(maxX, x!)
        minY = Math.min(minY, y!)
        maxY = Math.max(maxY, y!)
      }
  const x0 = Math.floor(minX) - 2
  const y0 = Math.floor(minY) - 2
  const x1 = Math.ceil(maxX) + 2
  const y1 = Math.ceil(maxY) + 2
  process.stdout.write(`elevation (DHMV II DSM and DTM, ${x1 - x0} x ${y1 - y0} m in ${TILE_M} m tiles) `)
  const dsm = await mosaic("DHMVII_DSM_1m", x0, y0, x1, y1, raw, refresh)
  const dtm = await mosaic("DHMVII_DTM_1m", x0, y0, x1, y1, raw, refresh)
  console.log()

  const buildings: BuildingRecord[] = []
  let towers = 0
  for (const j of joined) {
    const cells = sampleFootprint(dsm, dtm, j.lambert)
    if (cells.length === 0) continue
    const split = splitHeights(cells)
    const record: BuildingRecord = { id: j.id, h: Math.max(1, round1(split.body)), p: j.local }
    if (split.towers.length > 0) {
      record.t = split.towers.map((t) => ({
        h: round1(t.h),
        ...(t.s == null ? {} : { s: round1(t.s) }),
        r: cellHull(dsm, t.cells).flatMap(([X, Y]) => applyAffine(affine, X, Y).map(round1)),
      }))
      for (const t of record.t) if (ringArea2(t.r) < 0) reverseRing(t.r)
      towers += record.t.length
    }
    buildings.push(record)
  }
  buildings.sort((a, b) => a.id - b.id)

  const generated = new Date().toISOString()
  const full: BuildingsFile = { source: SOURCE, generated, buildings }
  const fixture: BuildingsFile = { source: SOURCE, generated, buildings: fixtureOf(buildings) }
  mkdirSync(join(root, "data"), { recursive: true })
  mkdirSync(join(root, "public", "fixtures"), { recursive: true })
  writeFileSync(join(root, "data", "buildings.json"), JSON.stringify(full))
  const fixtureText = JSON.stringify(fixture)
  writeFileSync(join(root, "public", "fixtures", "buildings.json"), fixtureText + "\n")
  console.log(`data/buildings.json: ${buildings.length} buildings, ${towers} tall parts`)
  console.log(`public/fixtures/buildings.json: ${fixture.buildings.length} buildings, ${(fixtureText.length / 1024).toFixed(0)} KB`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
