import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { FEEDS, feedsFor, type TrainFeed } from "../../src/layers/trains.ts"
import type { DataMode } from "../../src/view-state.ts"
import { sendJson, type Route } from "../api.ts"
import {
  cityStateProvider,
  lineColor,
  PLACES,
  setCityStateProvider,
  STATIONS,
  type CityState,
  type CityStateProvider,
  type Dock,
  type LineService,
  type LineStatus,
} from "../city-state.ts"
import { citibike, type CitibikeSnapshot, type CitibikeSource } from "./citibike.ts"
import { mta, type MtaSource } from "./mta.ts"

// The city state "ask the city" answers from in recorded and live mode, built from the
// trains (the MTA's realtime feeds, server/routes/mta.ts) and the Citi Bike docks
// (server/routes/citibike.ts), through the same cached sources the layers' routes use.
// Fixture mode keeps the hand-made sample in server/city-state.ts.
//
//   GET /api/city?mode=live                            the state a question is answered from now
//   GET /api/city?mode=recorded&t=2026-10-18T23:02:17Z  ... in recorded mode at time t
//
// The dev server loads every file in server/routes/, so this one also registers the
// recorded and live providers for /api/ask.

// The lines the questions can name: every line that stops at a station they know.
export const LINES: string[] = [...new Set(STATIONS.flatMap((s) => s.lines))]

const HOUR_S = 3600
// Trains further apart than this are a reduced service.
export const REDUCED_HEADWAY_MIN = 15

function service(id: string, headwayMin: number | null, status: LineStatus, note: string | null): LineService {
  return { id, color: lineColor(id), status, headwayMin, note }
}

// How each line runs at `at` (Unix seconds), from the trips in the feeds: the minutes
// between trains at its busiest platform over the next hour. The feeds carry no
// delays (those are in the MTA's alerts, not read here), so a line is "normal" when
// its trains come at least every REDUCED_HEADWAY_MIN, "reduced" when they come less
// often or fewer than two arrive in the hour, and "suspended" when no trip of it is
// in the feed at all. Lines whose feed is missing are left out, not guessed. The
// headway is the line's wherever it runs, so a weekend reroute away from these
// stations still counts as running.
export function lineServices(feeds: TrainFeed[], at: number, lines: string[] = LINES): LineService[] {
  const present = new Set(feeds.flatMap((f) => FEEDS[f.feed] ?? []))
  // Per line, per platform ("R22N"): when its trains arrive in the hour from `at`.
  const arrivals = new Map<string, Map<string, number[]>>()
  for (const feed of feeds) {
    for (const trip of feed.trips) {
      // The diamond expresses (6X, FX) are their line's trains.
      const line = trip.route.replace(/(.)X$/, "$1")
      let platforms = arrivals.get(line)
      if (platforms == null) arrivals.set(line, (platforms = new Map()))
      for (const stop of trip.stops) {
        if (stop.arrive < at || stop.arrive > at + HOUR_S) continue
        platforms.set(stop.id, [...(platforms.get(stop.id) ?? []), stop.arrive])
      }
    }
  }
  return lines
    .filter((id) => present.has(id))
    .map((id) => {
      const platforms = arrivals.get(id)
      if (platforms == null) return service(id, null, "suspended", "not running now: no trains in the MTA's realtime feed")
      let busiest: number[] = []
      for (const times of platforms.values()) if (times.length > busiest.length) busiest = times
      if (busiest.length < 2) return service(id, null, "reduced", "fewer than two trains in the next hour")
      busiest.sort((a, b) => a - b)
      const headway = Math.max(1, Math.round((busiest.at(-1)! - busiest[0]!) / (busiest.length - 1) / 60))
      return headway > REDUCED_HEADWAY_MIN
        ? service(id, headway, "reduced", `a train only every ${headway} min`)
        : service(id, headway, "normal", null)
    })
}

// The Citi Bike route's docks as the city state counts them: classic bikes and
// e-bikes apart, and nothing to rent at a dock that is not renting.
export function docksFrom(snapshot: CitibikeSnapshot): Dock[] {
  return snapshot.docks.map((d) => ({
    id: d.id,
    name: d.name,
    lat: d.lat,
    lon: d.lon,
    bikes: d.renting ? d.bikes - d.ebikes : 0,
    ebikes: d.renting ? d.ebikes : 0,
    freeDocks: d.docks,
  }))
}

const FEED_IDS = feedsFor(LINES)

function iso(seconds: number): string {
  return new Date(Math.round(seconds) * 1000).toISOString().replace(/\.000Z$/, "Z")
}

function state(source: DataMode, at: number, feeds: TrainFeed[], docks: Dock[]): CityState {
  return { time: iso(at), source, stations: STATIONS, places: PLACES, lines: lineServices(feeds, at), docks }
}

export type ProviderOptions = {
  mta?: MtaSource
  citibike?: CitibikeSource
  // The docks recorded mode shows (it draws the committed sample, as the layer does).
  recordedDocks?: () => CitibikeSnapshot
  now?: () => number
}

// The committed Citi Bike sample, the docks the layer draws outside live mode.
export const CITIBIKE_FIXTURE = fileURLToPath(new URL("../../public/fixtures/citibike.json", import.meta.url))

// Live: the feeds now. A question needs an answer in under a second, so a state up
// to MAX_AGE_MS old answers at once while a newer one loads every REFRESH_MS.
const REFRESH_MS = 15_000
const MAX_AGE_MS = 120_000

export function createLiveProvider(options: ProviderOptions = {}): CityStateProvider {
  const { mta: trains = mta, citibike: bikes = citibike, now = Date.now } = options
  let current: { at: number; state: CityState } | null = null
  let loading: Promise<CityState> | null = null

  async function load(): Promise<CityState> {
    const at = now()
    const [feeds, docks] = await Promise.all([
      Promise.allSettled(FEED_IDS.map((feed) => trains.live(feed))),
      bikes.get().then(docksFrom, (error: unknown) => {
        console.warn(`city state: Citi Bike: ${(error as Error).message}`)
        return [] as Dock[]
      }),
    ])
    feeds.forEach((r, i) => r.status === "rejected" && console.warn(`city state: MTA ${FEED_IDS[i]}: ${String(r.reason)}`))
    const next = state("live", at / 1000, feeds.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])), docks)
    current = { at, state: next }
    return next
  }

  return {
    source: "live",
    async get() {
      const age = current == null ? Infinity : now() - current.at
      if (age >= REFRESH_MS && loading == null) {
        loading = load().finally(() => (loading = null))
        // A refresh no question waits for must still not go unhandled.
        loading.catch((error: unknown) => console.warn(`city state: ${(error as Error).message}`))
      }
      if (current != null && age < MAX_AGE_MS) return current.state
      return loading!
    },
  }
}

// Recorded: the saved feeds at the view's time; with no time, the latest recording
// from its own start, as the trains layer plays it.
export function createRecordedProvider(options: ProviderOptions = {}): CityStateProvider {
  const {
    mta: trains = mta,
    recordedDocks = () => JSON.parse(readFileSync(CITIBIKE_FIXTURE, "utf8")) as CitibikeSnapshot,
    now = Date.now,
  } = options
  let docks: Dock[] | null = null
  const states = new Map<string, CityState>()
  return {
    source: "recorded",
    async get(time) {
      const hit = time == null ? undefined : states.get(time)
      if (hit != null) return hit
      const t = time == null ? now() / 1000 : Date.parse(time) / 1000
      const feeds = FEED_IDS.flatMap((feed) => trains.recorded(feed, t) ?? [])
      const at = time != null || feeds.length === 0 ? t : Math.max(...feeds.map((f) => f.timestamp))
      docks ??= docksFrom(recordedDocks())
      const next = state("recorded", at, feeds, docks)
      // Each time asked for is one state (without one, the latest recording may
      // change); a few dozen is plenty for a review.
      if (time != null) {
        if (states.size >= 50) states.delete(states.keys().next().value!)
        states.set(time, next)
      }
      return next
    },
  }
}

const MODES: readonly DataMode[] = ["fixture", "recorded", "live"]

export function cityRoute(provider: (mode: DataMode) => CityStateProvider = cityStateProvider): Route {
  return {
    method: "GET",
    path: "/api/city",
    async handle(_req, res, url) {
      const raw = url.searchParams.get("mode")
      const mode = MODES.includes(raw as DataMode) ? (raw as DataMode) : "fixture"
      const t = url.searchParams.get("t")
      if (t != null && Number.isNaN(Date.parse(t))) return sendJson(res, 400, { error: `t is not a time: "${t}"` })
      sendJson(res, 200, await provider(mode).get(t))
    },
  }
}

setCityStateProvider("recorded", createRecordedProvider())
setCityStateProvider("live", createLiveProvider())

export default cityRoute()
