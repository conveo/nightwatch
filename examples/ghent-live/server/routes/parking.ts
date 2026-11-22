import { readFile } from "node:fs/promises"
import { sendJson, type Route } from "../api.ts"
import type { GarageState } from "../city-state.ts"

// GET /api/parking: the occupancy of Ghent's parking garages, from Stad Gent's
// open data (dataset `bezetting-parkeergarages-real-time`, no key). The browser never
// fetches the city's feed itself: the parking layer (src/layers/parking.ts) reads
// this route in live mode. The answer is cached for 60 s, and when the feed fails a
// cached answer is served as it is, so the layer's notice reports its age.
//
//   { "time": "<ISO 8601, when the feed was read>", "garages": GarageState[] }
//
// The same shape is in public/fixtures/parking.json (fixture mode), and
// public/fixtures/parking/snapshots.json holds recorded answers keyed by time
// (recorded mode, written by scripts/record-parking.ts). `garageStates()` gives the
// garages for any mode in the `CityState` shape, for the live city state.

export const FEED_URL =
  "https://data.stad.gent/api/explore/v2.1/catalog/datasets/bezetting-parkeergarages-real-time/records?limit=100"
export const CACHE_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000

export type ParkingSnapshot = { time: string; garages: GarageState[] }
export type SnapshotFile = { snapshots: Record<string, GarageState[]> }

// One record of the feed, as far as this file reads it.
export type FeedRecord = {
  name?: unknown
  lastupdate?: unknown
  totalcapacity?: unknown
  availablecapacity?: unknown
  isopennow?: unknown
  temporaryclosed?: unknown
  location?: unknown
  locationanddimension?: unknown
}

// `garage:<slug>` (plan/PLAN.md, "Contracts"): the feed's name, lower case, ASCII
// with diacritics stripped, words joined by "-". "P+R The Loop" -> "p-r-the-loop".
export function slugify(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "")
  return words.join("-")
}

function finite(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

function latLon(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  const la = finite(lat)
  const lo = finite(lon)
  if (la == null || lo == null || Math.abs(la) > 90 || Math.abs(lo) > 180) return null
  return { lat: la, lon: lo }
}

// The coordinates sit in two places: `location` ({lat, lon}) and, inside the JSON
// string `locationanddimension`, `coordinatesForDisplay` ({latitude, longitude}).
// `location` wins; the string is the fallback when it is missing or malformed.
export function coordinates(record: FeedRecord): { lat: number; lon: number } | null {
  const loc = record.location as { lat?: unknown; lon?: unknown } | null | undefined
  const direct = loc != null && typeof loc === "object" ? latLon(loc.lat, loc.lon) : null
  if (direct != null) return direct
  const raw = record.locationanddimension
  if (typeof raw !== "string") return null
  try {
    const parsed = JSON.parse(raw) as { coordinatesForDisplay?: { latitude?: unknown; longitude?: unknown } } | null
    const c = parsed?.coordinatesForDisplay
    return c != null && typeof c === "object" ? latLon(c.latitude, c.longitude) : null
  } catch {
    return null
  }
}

// One garage, or null when the record lacks a name, a capacity, coordinates or a
// valid time. Availability is clamped to 0..capacity (the feed sometimes reports one
// place more than the capacity), and a garage that is closed now has no places to
// offer, so it counts as full.
export function parseRecord(record: FeedRecord): GarageState | null {
  const name = typeof record.name === "string" ? record.name.trim() : ""
  const capacity = finite(record.totalcapacity)
  const available = finite(record.availablecapacity)
  const at = coordinates(record)
  const updated = typeof record.lastupdate === "string" ? Date.parse(record.lastupdate) : Number.NaN
  if (name === "" || slugify(name) === "" || capacity == null || capacity <= 0 || available == null) return null
  if (at == null || Number.isNaN(updated)) return null
  const closed = finite(record.temporaryclosed) === 1 || finite(record.isopennow) === 0
  const cap = Math.round(capacity)
  return {
    slug: slugify(name),
    name,
    lat: at.lat,
    lon: at.lon,
    capacity: cap,
    available: closed ? 0 : Math.min(cap, Math.max(0, Math.round(available))),
    updated: new Date(updated).toISOString(),
  }
}

// The feed's answer ({ results: [...] }) as garages, sorted by slug. Two garages
// whose names give the same slug keep it unique with a suffix ("-2").
export function parseFeed(body: unknown): GarageState[] {
  const results = (body as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) throw new Error("parking feed: no results array")
  const garages = results.flatMap((r) => {
    const g = r != null && typeof r === "object" ? parseRecord(r as FeedRecord) : null
    return g == null ? [] : [g]
  })
  garages.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  const seen = new Map<string, number>()
  return garages.map((g) => {
    const n = (seen.get(g.slug) ?? 0) + 1
    seen.set(g.slug, n)
    return n === 1 ? g : { ...g, slug: `${g.slug}-${n}` }
  })
}

// The recorded snapshot nearest to `time`, or the latest when `time` is null.
export function nearestSnapshot(file: SnapshotFile, time: string | null): ParkingSnapshot | null {
  const times = Object.keys(file.snapshots).filter((t) => !Number.isNaN(Date.parse(t)))
  if (times.length === 0) return null
  const target = time == null ? Number.POSITIVE_INFINITY : Date.parse(time)
  let best = times[0]!
  for (const t of times) {
    const d = Math.abs(Date.parse(t) - target)
    const bestD = Math.abs(Date.parse(best) - target)
    if (d < bestD || (d === bestD && Date.parse(t) > Date.parse(best))) best = t
  }
  return { time: best, garages: file.snapshots[best]! }
}

type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

// The live source: one feed request per minute at most, however many callers and
// whether the feed answers or not, and the last good answer when it fails.
export function createParkingSource(options: { fetch?: Fetch; now?: () => number } = {}) {
  const fetchFeed = options.fetch ?? (globalThis.fetch as unknown as Fetch)
  const now = options.now ?? (() => Date.now())
  let cached: { at: number; snapshot: ParkingSnapshot } | null = null
  let inFlight: Promise<ParkingSnapshot> | null = null
  // The last attempt, kept apart from the cache: a failed read is not retried for
  // a minute, and the cached answer keeps its own age.
  let attempt: { at: number; error: unknown } | null = null

  async function load(): Promise<ParkingSnapshot> {
    const res = await fetchFeed(FEED_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    })
    if (!res.ok) throw new Error(`parking feed answered ${res.status}`)
    const snapshot = { time: new Date(now()).toISOString(), garages: parseFeed(await res.json()) }
    cached = { at: now(), snapshot }
    return snapshot
  }

  return {
    async current(): Promise<ParkingSnapshot> {
      if (cached != null && now() - cached.at < CACHE_MS) return cached.snapshot
      if (inFlight == null && attempt?.error != null && now() - attempt.at < CACHE_MS) {
        if (cached != null) return cached.snapshot
        throw attempt.error
      }
      if (inFlight == null) {
        const at = now()
        inFlight = load()
          .then(
            (snapshot) => {
              attempt = { at, error: null }
              return snapshot
            },
            (error: unknown) => {
              attempt = { at, error }
              throw error
            },
          )
          .finally(() => {
            inFlight = null
          })
      }
      try {
        return await inFlight
      } catch (error) {
        if (cached != null) return cached.snapshot
        throw error
      }
    },
  }
}

const live = createParkingSource()
const FIXTURE = new URL("../../public/fixtures/parking.json", import.meta.url)
const SNAPSHOTS = new URL("../../public/fixtures/parking/snapshots.json", import.meta.url)

// The garages in the `CityState` shape (server/city-state.ts) for a data mode and
// time, for the live city state (T9). All garages of the feed, also those outside
// AREA: a garage just outside the centre is still an answer to "where do I park".
export async function garageStates(options: {
  mode: "fixture" | "recorded" | "live"
  time: string | null
}): Promise<GarageState[]> {
  if (options.mode === "live") return (await live.current()).garages
  if (options.mode === "recorded") {
    const file = JSON.parse(await readFile(SNAPSHOTS, "utf8")) as SnapshotFile
    return nearestSnapshot(file, options.time)?.garages ?? []
  }
  return (JSON.parse(await readFile(FIXTURE, "utf8")) as ParkingSnapshot).garages
}

export function parkingRoute(source: { current(): Promise<ParkingSnapshot> }): Route {
  return {
    method: "GET",
    path: "/api/parking",
    async handle(_req, res) {
      try {
        sendJson(res, 200, await source.current())
      } catch (error) {
        sendJson(res, 502, { error: `parking feed unavailable: ${(error as Error).message}` })
      }
    },
  }
}

export default parkingRoute(live)
