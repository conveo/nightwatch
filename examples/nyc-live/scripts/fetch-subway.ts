// Download the MTA's static subway GTFS and write the subway layer's data: every line
// (GTFS shape) and station inside AREA, each line with its route colour and the
// stations along it. See SubwayData in src/layers/subway.ts for the format.
//
//   node scripts/fetch-subway.ts              # data/subway.json, the whole AREA
//   node scripts/fetch-subway.ts --fixture    # also public/fixtures/subway.json (FIXTURE_RADIUS_M)
//   node scripts/fetch-subway.ts --refresh    # download the feed again, even if data/ has it
//
// The feed is published under the MTA's terms (see README.md). It is saved in data/,
// which is not committed; only the small fixture is.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { inflateRawSync } from "node:zlib"
import { AREA, FIXTURE_RADIUS_M, inArea } from "../src/constants.ts"
import { toLocal, type LatLon } from "../src/geo.ts"
import {
  project,
  toPath,
  type SubwayData,
  type SubwayRoute,
  type SubwayShape,
  type SubwayStop,
} from "../src/layers/subway.ts"

// Where the MTA's developer page points (its own link redirects here over plain HTTP).
export const GTFS_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip"

// A small RFC 4180 reader: quoted fields may hold commas, doubled quotes and newlines.
// Rows are handed over one at a time, so stop_times.txt (36 MB) is never held as objects.
export function readCsv(text: string, onRow: (row: Record<string, string>) => void): void {
  let header: string[] | null = null
  let fields: string[] = []
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const endRow = () => {
    if (header == null) header = fields.map((h) => h.trim())
    else if (fields.length > 1 || fields[0] !== "") onRow(Object.fromEntries(header.map((h, j) => [h, fields[j] ?? ""])))
    fields = []
  }
  while (i <= text.length) {
    if (i === text.length) {
      if (fields.length > 0) endRow()
      break
    }
    let field: string
    if (text[i] === '"') {
      field = ""
      i++
      for (;;) {
        const quote = text.indexOf('"', i)
        if (quote < 0) throw new Error("unterminated quoted field")
        field += text.slice(i, quote)
        if (text[quote + 1] === '"') {
          field += '"'
          i = quote + 2
        } else {
          i = quote + 1
          break
        }
      }
    } else {
      let end = i
      while (end < text.length && text[end] !== "," && text[end] !== "\n" && text[end] !== "\r") end++
      field = text.slice(i, end)
      i = end
    }
    fields.push(field)
    if (text[i] === ",") {
      i++
      // A trailing comma ends the line with one more, empty, field.
      if (i === text.length || text[i] === "\n" || text[i] === "\r") fields.push("")
      else continue
    }
    if (text[i] === "\r") i++
    if (text[i] === "\n") i++
    endRow()
  }
}

export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = []
  readCsv(text, (row) => rows.push(row))
  return rows
}

// "#RRGGBB" from a GTFS colour ("F6BC26"), or the fallback when it is missing or malformed.
export function parseColor(hex: string | undefined, fallback: string): string {
  const h = (hex ?? "").trim().replace(/^#/, "")
  return /^[0-9a-f]{6}$/i.test(h) ? `#${h.toUpperCase()}` : fallback
}

// GTFS says a route without a colour is white, with black text.
export function parseRoutes(text: string): SubwayRoute[] {
  return parseCsv(text).map((r) => ({
    id: r.route_id!,
    name: r.route_short_name || r.route_id!,
    color: parseColor(r.route_color, "#FFFFFF"),
    textColor: parseColor(r.route_text_color, "#000000"),
  }))
}

// shapes.txt may list a shape's points in any order; shape_pt_sequence orders them.
export function parseShapes(text: string): Map<string, LatLon[]> {
  const raw = new Map<string, Array<{ seq: number; lat: number; lon: number }>>()
  readCsv(text, (r) => {
    const id = r.shape_id!
    let points = raw.get(id)
    if (points == null) raw.set(id, (points = []))
    points.push({ seq: Number(r.shape_pt_sequence), lat: Number(r.shape_pt_lat), lon: Number(r.shape_pt_lon) })
  })
  const shapes = new Map<string, LatLon[]>()
  for (const [id, points] of raw) shapes.set(id, points.sort((a, b) => a.seq - b.seq).map(({ lat, lon }) => ({ lat, lon })))
  return shapes
}

export type Station = { id: string; name: string; lat: number; lon: number }

export type Feed = {
  info: Record<string, string>
  routes: SubwayRoute[]
  shapes: Map<string, LatLon[]>
  // The route each shape belongs to, from trips.txt (a shape id's prefix is not reliable: "6..N02R" is the 6X).
  shapeRoute: Map<string, string>
  stations: Map<string, Station>
  // Parent station ids that each shape's trips stop at, and the routes stopping at each station.
  shapeStops: Map<string, Set<string>>
  stationRoutes: Map<string, Set<string>>
}

// The feed's tables, read by name: from the zip, or from strings in a test.
export function readFeed(file: (name: string) => string): Feed {
  const routes = parseRoutes(file("routes.txt"))
  const shapes = parseShapes(file("shapes.txt"))

  const stations = new Map<string, Station>()
  // Platforms ("R22N") point at their station ("R22") through parent_station.
  const parentOf = new Map<string, string>()
  readCsv(file("stops.txt"), (r) => {
    if (r.location_type === "1" || r.parent_station === "") {
      stations.set(r.stop_id!, { id: r.stop_id!, name: r.stop_name!, lat: Number(r.stop_lat), lon: Number(r.stop_lon) })
    }
    parentOf.set(r.stop_id!, r.parent_station || r.stop_id!)
  })

  const tripRoute = new Map<string, string>()
  const tripShape = new Map<string, string>()
  const routeCounts = new Map<string, Map<string, number>>()
  readCsv(file("trips.txt"), (r) => {
    tripRoute.set(r.trip_id!, r.route_id!)
    if (r.shape_id == null || r.shape_id === "") return
    tripShape.set(r.trip_id!, r.shape_id)
    const counts = routeCounts.get(r.shape_id) ?? new Map<string, number>()
    counts.set(r.route_id!, (counts.get(r.route_id!) ?? 0) + 1)
    routeCounts.set(r.shape_id, counts)
  })
  // Every shape in today's feed has one route; should one ever have two, the route with
  // the most trips wins.
  const shapeRoute = new Map<string, string>()
  for (const [shape, counts] of routeCounts) {
    shapeRoute.set(shape, [...counts].sort((a, b) => b[1] - a[1])[0]![0])
  }

  const shapeStops = new Map<string, Set<string>>()
  const stationRoutes = new Map<string, Set<string>>()
  readCsv(file("stop_times.txt"), (r) => {
    const station = parentOf.get(r.stop_id!) ?? r.stop_id!
    const shape = tripShape.get(r.trip_id!)
    if (shape != null) {
      const set = shapeStops.get(shape) ?? new Set<string>()
      set.add(station)
      shapeStops.set(shape, set)
    }
    const route = tripRoute.get(r.trip_id!)
    if (route != null) {
      const set = stationRoutes.get(station) ?? new Set<string>()
      set.add(route)
      stationRoutes.set(station, set)
    }
  })

  const info = parseCsv(file("feed_info.txt"))[0] ?? {}
  return { info, routes, shapes, shapeRoute, stations, shapeStops, stationRoutes }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

// Some MTA shapes run out to a point and straight back over the same points (the
// N..N20R does, by Canal St). No train does that, and a train placed along the shape
// would jump out and back, so the excursion is dropped: a point equal to the one
// before last undoes the last step.
export function dropBacktracks(points: LatLon[]): LatLon[] {
  const out: LatLon[] = []
  for (const p of points) {
    const before = out.at(-2)
    if (before != null && before.lat === p.lat && before.lon === p.lon) out.pop()
    else out.push(p)
  }
  return out
}

// The part of a line inside a region: from its first point inside to its last, plus
// the points where it crosses the boundary, so lines run right up to the edge.
export function clipLine(points: LatLon[], inside: (p: LatLon) => boolean): LatLon[] {
  const first = points.findIndex(inside)
  if (first < 0) return []
  const last = points.findLastIndex(inside)
  const out = points.slice(first, last + 1)
  if (first > 0) out.unshift(crossing(points[first]!, points[first - 1]!, inside))
  if (last < points.length - 1) out.push(crossing(points[last]!, points[last + 1]!, inside))
  return out
}

// Bisect between a point inside and one outside for where the line leaves the region.
function crossing(from: LatLon, to: LatLon, inside: (p: LatLon) => boolean): LatLon {
  const at = (f: number) => ({ lat: from.lat + (to.lat - from.lat) * f, lon: from.lon + (to.lon - from.lon) * f })
  let lo = 0
  let hi = 1
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (inside(at(mid))) lo = mid
    else hi = mid
  }
  return at(lo)
}

export function buildSubwayData(feed: Feed, inside: (p: LatLon) => boolean, clip: SubwayData["clip"]): SubwayData {
  const shapes: SubwayShape[] = []
  for (const [id, raw] of [...feed.shapes].sort((a, b) => a[0].localeCompare(b[0]))) {
    const route = feed.shapeRoute.get(id)
    if (route == null) continue
    const points = clipLine(dropBacktracks(raw), inside).map((p): [number, number] => [round6(p.lat), round6(p.lon)])
    if (points.length < 2) continue
    const path = toPath(points)
    const stops = [...(feed.shapeStops.get(id) ?? [])]
      .flatMap((sid) => {
        const station = feed.stations.get(sid)
        if (station == null || !inside(station)) return []
        return [{ id: sid, d: Math.round(project(path, toLocal(station)).d * 10) / 10 }]
      })
      .sort((a, b) => a.d - b.d)
    shapes.push({ id, route, points, stops })
  }

  const routeIds = new Set(shapes.map((s) => s.route))
  const stops: SubwayStop[] = [...feed.stations.values()]
    .filter((s) => inside(s) && feed.stationRoutes.has(s.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      lat: round6(s.lat),
      lon: round6(s.lon),
      routes: feed.routes.filter((r) => feed.stationRoutes.get(s.id)!.has(r.id)).map((r) => r.id),
    }))

  return {
    feed: {
      publisher: feed.info.feed_publisher_name ?? "",
      version: feed.info.feed_version ?? "",
      start: feed.info.feed_start_date ?? "",
      end: feed.info.feed_end_date ?? "",
    },
    clip,
    routes: feed.routes.filter((r) => routeIds.has(r.id)),
    shapes,
    stops,
  }
}

// One route, shape or stop per line, so a regenerated fixture diffs readably.
export function formatData(data: SubwayData): string {
  const list = (items: unknown[]) => `[\n${items.map((i) => `    ${JSON.stringify(i)}`).join(",\n")}\n  ]`
  return [
    "{",
    `  "feed": ${JSON.stringify(data.feed)},`,
    `  "clip": ${JSON.stringify(data.clip)},`,
    `  "routes": ${list(data.routes)},`,
    `  "shapes": ${list(data.shapes)},`,
    `  "stops": ${list(data.stops)}`,
    "}",
    "",
  ].join("\n")
}

// The feed is a zip. Node can inflate but has no zip reader, and these few lines
// spare a dependency: find the entry in the central directory, then inflate it.
export function readZipEntry(zip: Buffer, name: string): Buffer {
  let eocd = zip.length - 22
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error("not a zip file")
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip directory")
    const method = zip.readUInt16LE(p + 10)
    const size = zip.readUInt32LE(p + 20)
    const nameLength = zip.readUInt16LE(p + 28)
    const local = zip.readUInt32LE(p + 42)
    if (zip.toString("utf8", p + 46, p + 46 + nameLength) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const data = zip.subarray(start, start + size)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data)
      throw new Error(`${name}: unsupported zip compression ${method}`)
    }
    p += 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32)
  }
  throw new Error(`${name} is not in the feed`)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      fixture: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
    },
  })
  const here = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))
  const zipPath = here("data/gtfs_subway.zip")

  if (values.refresh || !existsSync(zipPath)) {
    console.log(`downloading ${GTFS_URL}`)
    const res = await fetch(GTFS_URL)
    if (!res.ok) throw new Error(`${GTFS_URL}: HTTP ${res.status}`)
    mkdirSync(dirname(zipPath), { recursive: true })
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
  }
  const zip = readFileSync(zipPath)
  const feed = readFeed((name) => readZipEntry(zip, name).toString("utf8"))
  console.log(`feed ${feed.info.feed_version}: ${feed.routes.length} routes, ${feed.shapes.size} shapes, ${feed.stations.size} stations`)

  const write = (path: string, data: SubwayData) => {
    const text = formatData(data)
    mkdirSync(dirname(here(path)), { recursive: true })
    writeFileSync(here(path), text)
    const kb = (Buffer.byteLength(text) / 1024).toFixed(0)
    console.log(`${path}: ${data.routes.length} routes, ${data.shapes.length} shapes, ${data.stops.length} stations, ${kb} KB`)
  }
  write("data/subway.json", buildSubwayData(feed, inArea, { area: AREA }))
  if (values.fixture) {
    const near = (p: LatLon) => {
      const { x, z } = toLocal(p)
      return Math.hypot(x, z) <= FIXTURE_RADIUS_M
    }
    write("public/fixtures/subway.json", buildSubwayData(feed, near, { radiusM: FIXTURE_RADIUS_M }))
  }
}

if (import.meta.main) await main()
