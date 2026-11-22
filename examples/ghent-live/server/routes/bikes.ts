import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { AREA, inArea } from "../../src/constants.ts"
import type { DataMode } from "../../src/view-state.ts"
import { sendJson, type Route } from "../api.ts"
import type { BikeStationState } from "../city-state.ts"

// GET /api/bikes: the shared-bike stations inside AREA with the bikes available now,
// merged on the server from Stad Gent's open data (no key):
//
//   Donkey Republic  donkey-republic-deelfietsen-stations-locaties (the stations)
//                    donkey-republic-beschikbaarheid-deelfietsen-per-station (bikes,
//                    joined on station_id; a station it does not list has 0 bikes)
//   Bolt             bolt-status-deelfietsstations-gent (stations with their bikes)
//   Blue-bike        one small dataset per group of stations, BLUE_BIKE_DATASETS
//
// The browser never fetches the city's feeds: the bikes layer (src/layers/bikes.ts)
// reads this route in live mode. The merged answer is cached for 60 s. A dataset that
// fails does not break the others: the answer holds what did arrive, and `feeds` says
// which operator is missing or incomplete, for the layer's notice.
//
//   { "time": "<ISO 8601, when the feeds were read>",
//     "stations": BikeStationState[],
//     "feeds": { "donkey": "ok", "bolt": "ok", "blue-bike": "missing" } }
//
// public/fixtures/bikes.json has the same shape (fixture mode). `bikeStations()` gives
// the stations for any mode in the `CityState` shape, for the live city state.

export type BikeOperator = BikeStationState["operator"]
// "partial": some of the operator's data arrived (Donkey Republic's stations without
// their availability, or some of Blue-bike's datasets).
export type FeedStatus = "ok" | "partial" | "missing"
export type BikesAnswer = {
  time: string
  stations: BikeStationState[]
  feeds: Record<BikeOperator, FeedStatus>
}

export const OPERATORS: readonly BikeOperator[] = ["donkey", "bolt", "blue-bike"]
export const CACHE_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000

const API = "https://data.stad.gent/api/explore/v2.1/catalog/datasets"

// Blue-bike publishes one dataset per station group (the stations at Gent-Sint-Pieters,
// Gent-Dampoort, and Merelbeke, Drongen and Wondelgem). None lies inside AREA today,
// but they are merged like the others, so a station that opens in the centre shows.
export const BLUE_BIKE_DATASETS = [
  "blue-bike-deelfietsen-gent-sint-pieters-m-hendrikaplein",
  "blue-bike-deelfietsen-gent-sint-pieters-st-denijslaan",
  "blue-bike-deelfietsen-gent-dampoort",
  "blue-bike-deelfietsen-merelbeke-drongen-wondelgem",
] as const

function exportUrl(dataset: string, params: Record<string, string>): string {
  return `${API}/${dataset}/exports/json?${new URLSearchParams(params).toString()}`
}

// Bolt lists thousands of stations across the city; asking for AREA only keeps the
// answer small. The merge filters on AREA again, so this is only an optimisation.
const IN_AREA = `lat >= ${AREA.south} and lat <= ${AREA.north} and lon >= ${AREA.west} and lon <= ${AREA.east}`

export const FEED_URLS = {
  donkeyLocations: exportUrl("donkey-republic-deelfietsen-stations-locaties", {
    select: "station_id,name,lat,lon",
    where: IN_AREA,
  }),
  donkeyAvailability: exportUrl("donkey-republic-beschikbaarheid-deelfietsen-per-station", {
    select: "station_id,num_bikes_available,is_renting",
  }),
  bolt: exportUrl("bolt-status-deelfietsstations-gent", {
    select: "station_id,name,lat,lon,num_bikes_available,is_renting",
    where: IN_AREA,
  }),
  blueBike: BLUE_BIKE_DATASETS.map((dataset) =>
    exportUrl(dataset, { select: "id,name,bikes_available,latitude,longitude" }),
  ),
}

// The records as far as this file reads them. Every field is checked before use.
export type DonkeyLocation = { station_id?: unknown; name?: unknown; lat?: unknown; lon?: unknown }
export type DonkeyAvailability = { station_id?: unknown; num_bikes_available?: unknown; is_renting?: unknown }
export type BoltStation = DonkeyLocation & { num_bikes_available?: unknown; is_renting?: unknown }
export type BlueBikeStation = {
  id?: unknown
  name?: unknown
  bikes_available?: unknown
  latitude?: unknown
  longitude?: unknown
}

// What each dataset answered: its records, or null when it failed.
export type RawFeeds = {
  donkeyLocations: DonkeyLocation[] | null
  donkeyAvailability: DonkeyAvailability[] | null
  bolt: BoltStation[] | null
  blueBike: Array<BlueBikeStation[] | null>
}

function finite(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

// Bikes a person can take now: a whole number, 0 when missing or malformed, and 0 at
// a station that is not renting.
export function bikesAvailable(count: unknown, renting?: unknown): number {
  if (finite(renting) === 0) return 0
  const n = finite(count)
  return n == null || n < 0 ? 0 : Math.floor(n)
}

// The records of a list that are objects; anything else in a feed (null, a number, a
// string) is skipped, so one malformed item never hides the rest.
function records<T>(list: readonly T[] | null): T[] {
  return (list ?? []).filter((item) => typeof item === "object" && item != null)
}

function feedStatus(parts: ReadonlyArray<unknown[] | null>): FeedStatus {
  const ok = parts.filter((p) => p != null).length
  return ok === parts.length ? "ok" : ok === 0 ? "missing" : "partial"
}

// The stations inside AREA from every dataset that answered, sorted by operator and id.
// A station needs an id and coordinates; one without a name is named by its id.
export function mergeBikeFeeds(raw: RawFeeds): Omit<BikesAnswer, "time"> {
  const stations = new Map<string, BikeStationState>()
  const add = (operator: BikeOperator, idValue: unknown, nameValue: unknown, latValue: unknown, lonValue: unknown, available: number) => {
    const id = text(idValue)
    const lat = finite(latValue)
    const lon = finite(lonValue)
    if (id == null || lat == null || lon == null || !inArea({ lat, lon })) return
    const key = `${operator}:${id}`
    if (stations.has(key)) return
    stations.set(key, { operator, id, name: text(nameValue) ?? id, lat, lon, available })
  }

  const donkeyBikes = new Map<string, number>()
  for (const a of records(raw.donkeyAvailability)) {
    const id = text(a.station_id)
    if (id != null) donkeyBikes.set(id, bikesAvailable(a.num_bikes_available, a.is_renting))
  }
  for (const s of records(raw.donkeyLocations)) {
    add("donkey", s.station_id, s.name, s.lat, s.lon, donkeyBikes.get(text(s.station_id) ?? "") ?? 0)
  }
  for (const s of records(raw.bolt)) {
    add("bolt", s.station_id, s.name, s.lat, s.lon, bikesAvailable(s.num_bikes_available, s.is_renting))
  }
  for (const feed of raw.blueBike) {
    for (const s of records(feed)) add("blue-bike", s.id, s.name, s.latitude, s.longitude, bikesAvailable(s.bikes_available))
  }

  const order = (s: BikeStationState) => OPERATORS.indexOf(s.operator)
  return {
    stations: [...stations.values()].sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id)),
    feeds: {
      // Without the locations there are no Donkey Republic stations to draw; without
      // the availability they are drawn with 0 bikes.
      donkey: raw.donkeyLocations == null ? "missing" : raw.donkeyAvailability == null ? "partial" : "ok",
      bolt: feedStatus([raw.bolt]),
      "blue-bike": feedStatus(raw.blueBike),
    },
  }
}

export type FetchJson = (url: string) => Promise<unknown>

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// Reads every dataset at most once per `cacheMs`; callers within that time share one
// answer (and one set of requests while it loads). It never rejects: a dataset that
// fails or answers something other than a list counts as missing.
export function createBikeFeed(options: { fetchJson?: FetchJson; now?: () => number; cacheMs?: number } = {}) {
  const get = options.fetchJson ?? fetchJson
  const now = options.now ?? Date.now
  const cacheMs = options.cacheMs ?? CACHE_MS
  let cached: { at: number; answer: Promise<BikesAnswer> } | null = null

  async function list<T>(url: string): Promise<T[] | null> {
    try {
      const body = await get(url)
      return Array.isArray(body) ? (body as T[]) : null
    } catch {
      return null
    }
  }

  async function load(at: number): Promise<BikesAnswer> {
    const [donkeyLocations, donkeyAvailability, bolt, ...blueBike] = await Promise.all([
      list<DonkeyLocation>(FEED_URLS.donkeyLocations),
      list<DonkeyAvailability>(FEED_URLS.donkeyAvailability),
      list<BoltStation>(FEED_URLS.bolt),
      ...FEED_URLS.blueBike.map((url) => list<BlueBikeStation>(url)),
    ])
    const merged = mergeBikeFeeds({
      donkeyLocations: donkeyLocations as DonkeyLocation[] | null,
      donkeyAvailability: donkeyAvailability as DonkeyAvailability[] | null,
      bolt: bolt as BoltStation[] | null,
      blueBike: blueBike as Array<BlueBikeStation[] | null>,
    })
    return { time: new Date(at).toISOString(), ...merged }
  }

  return {
    current(): Promise<BikesAnswer> {
      const at = now()
      if (cached == null || at - cached.at >= cacheMs) {
        const entry = { at, answer: load(at) }
        // load() catches every dataset's failure; should it reject all the same, the
        // next caller tries again instead of getting the rejection for a minute.
        entry.answer.catch(() => {
          if (cached === entry) cached = null
        })
        cached = entry
      }
      return cached.answer
    },
  }
}

const feed = createBikeFeed()

export const FIXTURE_PATH = fileURLToPath(new URL("../../public/fixtures/bikes.json", import.meta.url))

// The stations in the `CityState` shape, for the live city state. Fixture mode reads
// public/fixtures/bikes.json. There are no recorded bike snapshots, so recorded mode
// reads the fixture too (the layer says so in its notice).
export async function bikeStations(options: { mode: DataMode; time: string | null }): Promise<BikeStationState[]> {
  if (options.mode === "live") return (await feed.current()).stations
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as BikesAnswer
  return fixture.stations
}

const route: Route = {
  method: "GET",
  path: "/api/bikes",
  async handle(_req, res) {
    sendJson(res, 200, await feed.current())
  },
}

export default route
