import type { LatLon } from "../../src/geo.ts"
import { inArea } from "../../src/constants.ts"
import { sendJson, type Route } from "../api.ts"

// GET /api/citibike: every Citi Bike dock inside AREA with the bikes it holds now.
// The server reads the operator's GBFS feeds (the browser never fetches them),
// merges station_information with station_status, and keeps the answer for 30 s.
// The merged shape is exported for the layer and for the city state.

export const GBFS_FEEDS = {
  information: "https://gbfs.citibikenyc.com/gbfs/en/station_information.json",
  status: "https://gbfs.citibikenyc.com/gbfs/en/station_status.json",
}
export const CACHE_MS = 30_000

// The two GBFS feeds, reduced to the fields used here. GBFS 1.x and 2.x send the
// flags as 0 or 1, GBFS 3 as booleans; both are accepted.
export type GbfsStationInformation = {
  last_updated: number
  data: { stations: { station_id: string; name: string; lat: number; lon: number; capacity?: number }[] }
}
export type GbfsStationStatus = {
  last_updated: number
  data: {
    stations: {
      station_id: string
      // All bikes ready to rent, e-bikes included.
      num_bikes_available: number
      num_ebikes_available?: number
      num_docks_available?: number
      is_installed: number | boolean
      is_renting: number | boolean
    }[]
  }
}

export type CitibikeDock = {
  id: string
  name: string
  lat: number
  lon: number
  capacity: number
  // Bikes ready to rent, e-bikes included; `ebikes` is the electric share of them.
  bikes: number
  ebikes: number
  // Free docks to return a bike to.
  docks: number
  renting: boolean
}

export type CitibikeSnapshot = {
  // When the operator last updated station_status (ISO 8601).
  updated: string
  docks: CitibikeDock[]
}

function count(n: number | undefined): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n!)) : 0
}

// Joins the two feeds on station_id. A station missing from either feed, not
// installed, or outside `keep` is left out; docks come back sorted by id.
export function mergeGbfs(
  information: GbfsStationInformation,
  status: GbfsStationStatus,
  keep: (p: LatLon) => boolean = inArea,
): CitibikeSnapshot {
  const byId = new Map(status.data.stations.map((s) => [s.station_id, s]))
  const docks: CitibikeDock[] = []
  for (const info of information.data.stations) {
    const now = byId.get(info.station_id)
    if (now == null || !now.is_installed || !keep(info)) continue
    const bikes = count(now.num_bikes_available)
    const docksFree = count(now.num_docks_available)
    docks.push({
      id: info.station_id,
      name: info.name,
      lat: info.lat,
      lon: info.lon,
      capacity: count(info.capacity) || bikes + docksFree,
      bikes,
      ebikes: Math.min(count(now.num_ebikes_available), bikes),
      docks: docksFree,
      renting: Boolean(now.is_renting),
    })
  }
  docks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { updated: new Date(status.last_updated * 1000).toISOString(), docks }
}

async function fetchFeed<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as T
}

export type CitibikeSource = { get(): Promise<CitibikeSnapshot> }

// Fetches both feeds at most once per CACHE_MS; concurrent callers share one
// request. If a refresh fails, the last good snapshot is served (its `updated`
// shows its age); with none yet, the error reaches the caller.
export function createCitibikeSource(
  fetchJson: <T>(url: string) => Promise<T> = fetchFeed,
  now: () => number = Date.now,
): CitibikeSource {
  let fresh: { at: number; snapshot: Promise<CitibikeSnapshot> } | null = null
  let lastGood: CitibikeSnapshot | null = null
  return {
    get() {
      if (fresh != null && now() - fresh.at < CACHE_MS) return fresh.snapshot
      const snapshot: Promise<CitibikeSnapshot> = Promise.all([
        fetchJson<GbfsStationInformation>(GBFS_FEEDS.information),
        fetchJson<GbfsStationStatus>(GBFS_FEEDS.status),
      ])
        .then(([information, status]) => (lastGood = mergeGbfs(information, status)))
        .catch((error: unknown) => {
          // A failure is not cached: the next request tries the feeds again.
          if (fresh?.snapshot === snapshot) fresh = null
          if (lastGood != null) return lastGood
          throw error
        })
      fresh = { at: now(), snapshot }
      return snapshot
    },
  }
}

export function citibikeRoute(source: CitibikeSource): Route {
  return {
    method: "GET",
    path: "/api/citibike",
    async handle(_req, res) {
      try {
        sendJson(res, 200, await source.get())
      } catch (error) {
        sendJson(res, 502, { error: `Citi Bike feed unavailable: ${(error as Error).message}` })
      }
    },
  }
}

// The one shared source: the route serves it, and the city state can read it too.
export const citibike = createCitibikeSource()

export default citibikeRoute(citibike)
