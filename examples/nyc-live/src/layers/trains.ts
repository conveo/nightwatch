import {
  BoxGeometry,
  Color,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from "three"
import { SUBWAY_DEPTH_M } from "../constants.ts"
import { loadSubwayData, pointAlong, seeThrough, stationId, toPath, type Path, type SubwayData, type SubwayShape } from "./subway.ts"
import type { Layer, LayerContext } from "./types.ts"

// Live train positions from the MTA's realtime feeds, moving along the subway lines.
// Owned by ticket T4 in plan/PLAN.md.
//
// The dev server's /api/mta/<feed> (server/routes/mta.ts) fetches and decodes a feed
// and answers with the simplified trips below: each trip's remaining stops with their
// predicted times. This layer finds each trip's line among the subway layer's shapes,
// works out how far along it the train is at the scene's clock, and draws a short
// block there in the route's colour. In live mode it asks again every 30 s; in
// recorded mode it plays the saved snapshots back from the time in the URL.

// The MTA publishes one realtime feed per group of lines.
export const FEEDS: Record<string, string[]> = {
  "1234567": ["1", "2", "3", "4", "5", "6", "6X", "7", "7X", "GS"],
  ace: ["A", "C", "E", "H", "FS"],
  bdfm: ["B", "D", "F", "FX", "M"],
  g: ["G"],
  jz: ["J", "Z"],
  l: ["L"],
  nqrw: ["N", "Q", "R", "W"],
  si: ["SI"],
}

// The feeds that carry these routes, in FEEDS order.
export function feedsFor(routes: Iterable<string>): string[] {
  const wanted = new Set(routes)
  return Object.keys(FEEDS).filter((feed) => FEEDS[feed]!.some((r) => wanted.has(r)))
}

// What /api/mta/<feed> returns. Times are Unix seconds, as in GTFS-realtime.
export type FeedStop = { id: string; arrive: number; depart: number }
export type FeedTrip = { id: string; route: string; stops: FeedStop[] }
export type TrainFeed = {
  feed: string
  source: "live" | "recorded" | "fixture"
  // When the MTA produced the feed (its header timestamp).
  timestamp: number
  trips: FeedTrip[]
}

// "105600_N..S36R" -> "N..S36R". A realtime trip id ends in a GTFS shape id, but the
// shape is not always in the static feed (supplement and realtime-only patterns).
export function shapeIdOf(tripId: string): string {
  return tripId.slice(tripId.indexOf("_") + 1)
}

// "N..S36R" -> "S", "1..N" -> "N": the direction after the "..".
function directionOf(id: string): string | null {
  return /\.\.([NS])/.exec(id)?.[1] ?? null
}

// The shape a trip runs along: the one its id names when the subway data has it,
// otherwise the shape of its route and direction that best fits the stations it still
// stops at (most of them on the shape, fewest of the shape's stations skipped between
// them), so a local is not drawn on the express tracks. A train rerouted onto another
// line's tracks (a C running on the F) takes that line's shape if it stops at two or
// more of its stations. Null when no shape fits.
export function matchShape(trip: FeedTrip, shapes: Map<string, SubwayShape>, byRoute: Map<string, SubwayShape[]>): SubwayShape | null {
  const named = shapes.get(shapeIdOf(trip.id))
  if (named != null) return named
  const direction = directionOf(trip.id)
  const stations = new Set(trip.stops.map((s) => stationId(s.id)))
  const best = (candidates: Iterable<SubwayShape>, minHits: number) => {
    let found: { shape: SubwayShape; score: number } | null = null
    for (const shape of candidates) {
      if (direction != null && directionOf(shape.id) !== direction) continue
      const hits = shape.stops.flatMap((s, i) => (stations.has(s.id) ? [i] : []))
      if (hits.length < minHits) continue
      let skipped = 0
      for (let i = hits[0]!; i <= hits.at(-1)!; i++) if (!stations.has(shape.stops[i]!.id)) skipped++
      const score = hits.length - skipped
      if (found == null || score > found.score) found = { shape, score }
    }
    return found?.shape ?? null
  }
  return best(byRoute.get(trip.route) ?? [], 1) ?? best(shapes.values(), 2)
}

// A trip's stops that lie on its shape, with their distance along it, in time order.
export type Run = {
  path: Path
  stops: Array<{ d: number; arrive: number; depart: number }>
  // The station before the first of them on the shape, where a train that already
  // left it is still somewhere behind the first known stop.
  before: number | null
  // The stops the trip makes before its first stop on the shape (outside the area).
  outsideFirst: FeedStop[]
  // The trip ends at its last stop on the shape (a terminal inside the area).
  ends: boolean
  // Metres per second between stops, for the parts of the run no two stops bracket.
  speed: number
}

// Metres per second, a subway train's usual pace between stations.
export const DEFAULT_SPEED = 9

export function toRun(trip: FeedTrip, shape: SubwayShape, path: Path = toPath(shape.points)): Run | null {
  const order = new Map(shape.stops.map((s, i) => [s.id, i]))
  const stops: Run["stops"] = []
  let firstIndex = -1
  let lastTripIndex = -1
  let lastShapeIndex = -1
  trip.stops.forEach((stop, k) => {
    const i = order.get(stationId(stop.id))
    // A stop the shape does not pass, or one out of order, is not placed.
    if (i == null || i <= lastShapeIndex) return
    if (firstIndex < 0) firstIndex = k
    lastShapeIndex = i
    lastTripIndex = k
    stops.push({ d: shape.stops[i]!.d, arrive: stop.arrive, depart: stop.depart })
  })
  if (stops.length === 0) return null
  const firstShapeIndex = order.get(stationId(trip.stops[firstIndex]!.id))!
  const speeds: number[] = []
  for (let i = 1; i < stops.length; i++) {
    const dt = stops[i]!.arrive - stops[i - 1]!.depart
    if (dt > 0) speeds.push((stops[i]!.d - stops[i - 1]!.d) / dt)
  }
  speeds.sort((a, b) => a - b)
  const median = speeds[speeds.length >> 1]
  return {
    path,
    stops,
    before: firstShapeIndex > 0 ? shape.stops[firstShapeIndex - 1]!.d : null,
    outsideFirst: trip.stops.slice(0, firstIndex),
    ends: lastTripIndex === trip.stops.length - 1,
    speed: median == null ? DEFAULT_SPEED : Math.min(Math.max(median, 4), 20),
  }
}

// How long a train stays drawn at the terminal it has reached.
const TERMINAL_HOLD_S = 60
// A first stop further off than this, with none before it, is a trip that has not
// started yet (or a train held far away), not one between two stations.
const NOT_STARTED_S = 300

// How far along its shape (metres) the train is at time `t` (Unix seconds), or null
// when it is not on the drawn part of the line. Between two known stops it moves at
// an even pace from one's departure to the next one's arrival. Before its first known
// stop it runs in at `speed`, but no further back than the station before it on the
// shape, which it has left; or, coming from a station off the line, evenly from that
// station's departure, entering at the line's start at the latest. After its last
// known stop it runs on at `speed` until it leaves the line.
export function positionAt(run: Run, t: number): number | null {
  const { stops, speed } = run
  const next = stops.findIndex((s) => s.arrive > t)
  let d: number
  if (next < 0) {
    const last = stops.at(-1)!
    if (t <= last.depart) d = last.d
    else if (run.ends) return t - last.depart <= TERMINAL_HOLD_S ? last.d : null
    else d = last.d + speed * (t - last.depart)
  } else if (next > 0 && t <= stops[next - 1]!.depart) {
    d = stops[next - 1]!.d
  } else if (next > 0) {
    const a = stops[next - 1]!
    const b = stops[next]!
    d = a.d + ((b.d - a.d) * (t - a.depart)) / (b.arrive - a.depart)
  } else {
    const first = stops[0]!
    const outside = run.outsideFirst.at(-1)
    if (outside != null) {
      // Still to leave a station off the line, it is not on the line yet.
      if (t < outside.depart) return null
      const from = Math.min(first.d - speed * (first.arrive - outside.depart), 0)
      d = from + ((first.d - from) * (t - outside.depart)) / (first.arrive - outside.depart)
    } else {
      if (first.arrive - t > NOT_STARTED_S) return null
      d = Math.max(first.d - speed * (first.arrive - t), run.before ?? -Infinity)
    }
  }
  return d >= 0 && d <= run.path.length ? d : null
}

// A trip from a newer feed forgets the stops it has passed. Keeping the ones an older
// feed knew lets a train that left its last stop on the line keep moving off it.
export function mergeTrip(older: FeedTrip | undefined, newer: FeedTrip): FeedTrip {
  if (older == null || newer.stops.length === 0) return newer
  const first = newer.stops[0]!.arrive
  const known = new Set(newer.stops.map((s) => s.id))
  const passed = older.stops.filter((s) => s.arrive < first && !known.has(s.id))
  return passed.length === 0 ? newer : { ...newer, stops: [...passed, ...newer.stops] }
}

// Data older than a minute may not show where the trains are now; the MTA's terms
// ask the app to say so.
export const STALE_AFTER_MS = 60_000

const TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

export function trainsSummary(count: number, dataTime: number | null, nowMs: number, failed: string[] = []): string {
  const parts = [`${count} ${count === 1 ? "train" : "trains"}`]
  if (dataTime != null && nowMs - dataTime * 1000 > STALE_AFTER_MS) {
    parts.push(`MTA data from ${TIME.format(dataTime * 1000)} ET: positions may not be real time`)
  }
  if (failed.length > 0) parts.push(`no train data for ${failed.join(", ")}`)
  return parts.join(" · ")
}

// The see-through copy of the blocks (see seeThrough in subway.ts): trains are what
// moves, so they show clearly through the ground and the buildings.
export const TRAINS_XRAY_OPACITY = 0.85

// About a two-car length, and wider and taller than the subway's tube, so a block
// stands out of the line it runs on.
const BLOCK = { width: 14, height: 13, length: 70 }
const MAX_TRAINS = 1024
export const REFRESH_MS = 30_000
// The fixture's predictions run out after a while, so its clock starts over.
const FIXTURE_LOOP_S = 30 * 60

// The fixture's lines reach only FIXTURE_RADIUS_M from the venue, where a train passes
// in a minute or two, so at the moment it was saved there may be none. Its clock starts
// at the moment of its first half hour with the most trains on screen (the earliest
// such moment, so it does not depend on anything but the files).
export function busiestMoment(runs: Run[], from: number, spanS = FIXTURE_LOOP_S, stepS = 15): number {
  let best = { t: from, count: -1 }
  for (let t = from; t <= from + spanS; t += stepS) {
    const count = runs.filter((run) => positionAt(run, t) != null).length
    if (count > best.count) best = { t, count }
  }
  return best.t
}

export type TrainsOptions = {
  loadSubway?: (ctx: LayerContext) => Promise<SubwayData>
  // Where the feeds come from: one request per feed, with `t` (ISO) in recorded mode.
  loadFeed?: (feed: string, mode: LayerContext["mode"], t: string | null) => Promise<TrainFeed>
  // Wall-clock milliseconds, for the data's age and live positions.
  now?: () => number
}

// Recorded mode with no time asks for the latest snapshot: the last one before now.
export async function fetchTrainFeed(feed: string, mode: LayerContext["mode"], t: string | null): Promise<TrainFeed> {
  const at = t ?? new Date().toISOString()
  const query = mode === "fixture" ? "?fixture" : mode === "recorded" ? `?t=${encodeURIComponent(at)}` : ""
  const res = await fetch(`/api/mta/${feed}${query}`)
  if (!res.ok) throw new Error(`/api/mta/${feed}: HTTP ${res.status}`)
  return (await res.json()) as TrainFeed
}

export function createTrainsLayer(options: TrainsOptions = {}): Layer {
  const { loadSubway = loadSubwayData, loadFeed = fetchTrainFeed, now = Date.now } = options
  const group = new Group()
  group.name = "trains"

  let ctx: LayerContext = { mode: "fixture", time: null }
  let feeds: string[] = []
  const shapes = new Map<string, SubwayShape>()
  const byRoute = new Map<string, SubwayShape[]>()
  const paths = new Map<string, Path>()
  const colors = new Map<string, Color>()
  const feedData = new Map<string, TrainFeed>()
  let trips = new Map<string, FeedTrip>()
  let runs: Array<{ route: string; run: Run }> = []
  let failed: string[] = []
  const mesh = new InstancedMesh(new BoxGeometry(BLOCK.width, BLOCK.height, BLOCK.length), new MeshBasicMaterial(), MAX_TRAINS)
  mesh.name = "train-blocks"
  mesh.count = 0
  // The blocks move every frame; their bounds would always be stale.
  mesh.frustumCulled = false
  group.add(mesh)
  // The same blocks again, see-through and over the buildings and the ground, so a
  // train under them still shows; after the subway's own see-through tubes (0.5) and
  // before the streets (1). They share the blocks' positions and colours.
  mesh.setColorAt(0, WHITE)
  const xray = seeThrough(new InstancedMesh(mesh.geometry, new MeshBasicMaterial({ depthTest: false }), MAX_TRAINS), TRAINS_XRAY_OPACITY)
  xray.name = "train-blocks-xray"
  xray.instanceMatrix = mesh.instanceMatrix
  xray.instanceColor = mesh.instanceColor
  xray.count = 0
  xray.frustumCulled = false
  xray.renderOrder = 0.75
  mesh.add(xray)
  let loaded = false
  let drawn = 0
  // The scene's clock in fixture and recorded mode: Unix seconds `t` at performance
  // time `at` (ms). It starts when the first feed arrives.
  let start: { t: number; at: number } | null = null
  let lastRefresh = 0
  let refreshing = false

  const clock = (perfNow: number): number | null => {
    if (ctx.mode === "live") return now() / 1000
    if (start == null) return null
    const elapsed = (perfNow - start.at) / 1000
    return start.t + (ctx.mode === "fixture" ? elapsed % FIXTURE_LOOP_S : elapsed)
  }

  async function load(t: string | null): Promise<void> {
    const results = await Promise.allSettled(feeds.map((feed) => loadFeed(feed, ctx.mode, t)))
    failed = []
    results.forEach((r, i) => {
      if (r.status === "fulfilled") feedData.set(feeds[i]!, r.value)
      else {
        failed.push(feeds[i]!)
        console.warn(`trains: ${feeds[i]}: ${String(r.reason)}`)
      }
    })
    const next = new Map<string, FeedTrip>()
    for (const data of feedData.values()) for (const trip of data.trips) next.set(trip.id, mergeTrip(trips.get(trip.id), trip))
    trips = next
    runs = []
    for (const trip of trips.values()) {
      const shape = matchShape(trip, shapes, byRoute)
      if (shape == null) continue
      const run = toRun(trip, shape, paths.get(shape.id))
      // A rerouted train keeps its own colour on the other line's tracks.
      if (run != null) runs.push({ route: colors.has(trip.route) ? trip.route : shape.route, run })
    }
  }

  // The oldest feed on screen sets the data's age.
  const dataTime = (): number | null =>
    feedData.size === 0 ? null : Math.min(...[...feedData.values()].map((f) => f.timestamp))

  const m = new Matrix4()
  const q = new Quaternion()
  const e = new Euler()
  const p = new Vector3()
  const scale = new Vector3(1, 1, 1)

  // Recorded mode starts at the URL's time; without one it plays the latest recording
  // from its start. The fixture starts at its busiest moment.
  function startClock(perfNow: number): void {
    const saved = dataTime()
    if (start != null || saved == null) return
    const t =
      ctx.mode === "recorded" && ctx.time != null
        ? Date.parse(ctx.time) / 1000
        : ctx.mode === "fixture"
          ? busiestMoment(runs.map((r) => r.run), saved)
          : saved
    start = { t, at: perfNow }
  }

  function place(perfNow: number): void {
    const t = clock(perfNow)
    drawn = 0
    // Until the clock starts there is nothing to place.
    if (t != null) for (const { route, run } of runs) {
      if (drawn >= MAX_TRAINS) break
      const d = positionAt(run, t)
      if (d == null) continue
      // The whole block stays on the line, so none of it hangs past where the line ends.
      const half = Math.min(BLOCK.length / 2, run.path.length / 2)
      const at = pointAlong(run.path, Math.min(Math.max(d, half), run.path.length - half))
      p.set(at.x, SUBWAY_DEPTH_M + 1, at.z)
      q.setFromEuler(e.set(0, Math.atan2(at.dir.x, at.dir.z), 0))
      mesh.setMatrixAt(drawn, m.compose(p, q, scale))
      mesh.setColorAt(drawn, colors.get(route) ?? WHITE)
      drawn++
    }
    mesh.count = drawn
    xray.count = drawn
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor != null) mesh.instanceColor.needsUpdate = true
  }

  // Live mode asks again every REFRESH_MS, and recorded mode asks for the snapshot at
  // the scene's clock, so it plays the recording. The fixture does not change, so it
  // asks again only while a feed is missing.
  function refresh(perfNow: number): void {
    if (refreshing || perfNow - lastRefresh < REFRESH_MS) return
    if (ctx.mode === "fixture" && failed.length === 0) return
    refreshing = true
    lastRefresh = perfNow
    const at = clock(perfNow)
    const t = ctx.mode === "recorded" ? (at == null ? ctx.time : new Date(at * 1000).toISOString()) : null
    load(t)
      .then(() => startClock(performance.now()))
      .catch((error: unknown) => console.warn(`trains: ${(error as Error).message}`))
      .finally(() => (refreshing = false))
  }

  const layer: Layer = {
    id: "trains",
    group,
    async init(context) {
      ctx = context
      const subway = await loadSubway(context)
      for (const shape of subway.shapes) {
        shapes.set(shape.id, shape)
        byRoute.set(shape.route, [...(byRoute.get(shape.route) ?? []), shape])
        paths.set(shape.id, toPath(shape.points))
      }
      for (const route of subway.routes) colors.set(route.id, trainColor(route.color))
      feeds = feedsFor(subway.routes.map((r) => r.id))
      // A feed that fails is asked for again at the next refresh, and the HUD names it
      // meanwhile, so a brief outage at startup does not leave the layer empty.
      await load(context.mode === "recorded" ? context.time : null)
      loaded = true
      lastRefresh = performance.now()
      startClock(lastRefresh)
      place(lastRefresh)
    },
    update(nowMs) {
      refresh(nowMs)
      place(nowMs)
    },
    summary() {
      if (!loaded) return null
      return trainsSummary(drawn, dataTime(), now(), failed)
    },
  }
  playback.set(layer, (perfNow) => (ctx.mode === "recorded" ? clock(perfNow) : null))
  return layer
}

// Each trains layer's clock in recorded mode, read through playbackTime().
const playback = new WeakMap<Layer, (perfNow: number) => number | null>()

// The moment recorded mode is playing (ISO 8601, whole seconds), or null in other modes
// and until the first feed arrives. main.ts keeps the URL's `t` on it, so the ask panel
// asks about the moment on screen and a review note reopens it.
export function playbackTime(layer: Layer, perfNow = performance.now()): string | null {
  const t = playback.get(layer)?.(perfNow)
  return t == null ? null : new Date(Math.floor(t) * 1000).toISOString().replace(/\.000Z$/, "Z")
}

const WHITE = new Color(0xffffff)

// A train is its line's colour, a little lighter (in sRGB, as people see it), so it
// reads as lit against the tube it runs in.
export function trainColor(hex: string, lighten = 0.12): Color {
  const color = new Color(hex)
  const hsl = { h: 0, s: 0, l: 0 }
  color.getHSL(hsl, SRGBColorSpace)
  return color.setHSL(hsl.h, hsl.s, Math.min(hsl.l + lighten, 0.92), SRGBColorSpace)
}
