import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import GtfsRealtimeBindings from "gtfs-realtime-bindings"
import { FEEDS, type FeedTrip, type TrainFeed } from "../../src/layers/trains.ts"
import { sendJson, type Route } from "../api.ts"

// GET /api/mta/<feed>: one of the MTA's subway GTFS-realtime feeds (see FEEDS in
// src/layers/trains.ts), decoded and simplified to each trip's remaining stops. The
// MTA's terms ask that the app serve the feeds from its own server, so the browser
// never fetches them itself.
//
//   /api/mta/nqrw                         live, fetched at most every 15 s
//   /api/mta/nqrw?t=2026-10-18T22:53:00Z  recorded: the last snapshot at or before t
//   /api/mta/nqrw?fixture                 the committed snapshot in public/fixtures/trains/
//
// Snapshots are the feed's own protobuf, saved by scripts/record-feeds.ts as
// <feed>-<YYYYMMDDTHHMMSSZ>.pb: recordings in data/trains/ (not committed), small
// samples in public/fixtures/trains/.

const { transit_realtime } = GtfsRealtimeBindings

export const MTA_FEED_URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs"

// The MTA names the numbered lines' feed "gtfs" and the others "gtfs-<letters>".
export function feedUrl(feed: string): string {
  return feed === "1234567" ? MTA_FEED_URL : `${MTA_FEED_URL}-${feed}`
}

const here = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url))
export const RECORDINGS_DIR = here("data/trains")
export const FIXTURES_DIR = here("public/fixtures/trains")

export const CACHE_MS = 15_000

// Each trip with its stops in order, and the time the train arrives at and leaves each
// one. The MTA often gives only one of the two; a stop with neither is dropped, and so
// is a cancelled trip.
export function simplifyFeed(feed: string, source: TrainFeed["source"], buffer: Uint8Array): TrainFeed {
  const message = transit_realtime.FeedMessage.decode(buffer)
  const trips: FeedTrip[] = []
  for (const entity of message.entity) {
    const update = entity.tripUpdate
    const trip = update?.trip
    if (update == null || trip?.tripId == null || trip.routeId == null) continue
    if (trip.scheduleRelationship === transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED) continue
    const stops = (update.stopTimeUpdate ?? []).flatMap((u) => {
      const arrive = Number(u.arrival?.time ?? u.departure?.time ?? 0)
      const depart = Number(u.departure?.time ?? u.arrival?.time ?? 0)
      return u.stopId == null || arrive <= 0 ? [] : [{ id: u.stopId, arrive, depart: Math.max(depart, arrive) }]
    })
    if (stops.length > 0) trips.push({ id: trip.tripId, route: trip.routeId, stops })
  }
  return { feed, source, timestamp: Number(message.header.timestamp ?? 0), trips }
}

// "nqrw", 1792364015 -> "nqrw-20261018T225335Z.pb"
export function snapshotName(feed: string, timestamp: number): string {
  const iso = new Date(timestamp * 1000).toISOString().replace(/\.\d+Z$/, "Z")
  return `${feed}-${iso.replaceAll("-", "").replaceAll(":", "")}.pb`
}

export function snapshotTime(name: string): number | null {
  const m = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.pb$/.exec(name)
  return m == null ? null : Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000
}

// The snapshot of `feed` to show at time `t` (Unix seconds): the last one at or before
// it, or the earliest when t is before every recording; null when there is none.
export function findSnapshot(dirs: string[], feed: string, t: number): string | null {
  let before: { path: string; time: number } | null = null
  let after: { path: string; time: number } | null = null
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${feed}-`)) continue
      const time = snapshotTime(name)
      if (time == null) continue
      const path = join(dir, name)
      if (time <= t) {
        if (before == null || time > before.time) before = { path, time }
      } else if (after == null || time < after.time) after = { path, time }
    }
  }
  return (before ?? after)?.path ?? null
}

export async function fetchFeed(feed: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const res = await fetchImpl(feedUrl(feed), { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`MTA ${feed} feed: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

export type MtaOptions = {
  fetch?: typeof fetch
  now?: () => number
  recordings?: string
  fixtures?: string
}

export function createMtaRoute(options: MtaOptions = {}): Route {
  const { fetch: fetchImpl = fetch, now = Date.now, recordings = RECORDINGS_DIR, fixtures = FIXTURES_DIR } = options
  // Per feed: the request in flight or answered in the last CACHE_MS, and the last
  // good answer, served if the MTA cannot be reached (the HUD then shows its age).
  const cache = new Map<string, { at: number; feed: Promise<TrainFeed> }>()
  const lastGood = new Map<string, TrainFeed>()

  function live(feed: string): Promise<TrainFeed> {
    const hit = cache.get(feed)
    if (hit != null && now() - hit.at < CACHE_MS) return hit.feed
    const load = fetchFeed(feed, fetchImpl)
      .then((buffer) => simplifyFeed(feed, "live", buffer))
      .then(
        (data) => {
          lastGood.set(feed, data)
          return data
        },
        (error: unknown) => {
          // A failure is not cached: the next request asks the MTA again.
          if (cache.get(feed)?.feed === load) cache.delete(feed)
          const stale = lastGood.get(feed)
          if (stale != null) return stale
          throw error
        },
      )
    cache.set(feed, { at: now(), feed: load })
    return load
  }

  return {
    method: "GET",
    path: "/api/mta/*",
    async handle(_req, res, url) {
      const feed = decodeURIComponent(url.pathname.slice("/api/mta/".length))
      if (!Object.hasOwn(FEEDS, feed)) {
        return sendJson(res, 404, { error: `unknown feed "${feed}"; one of ${Object.keys(FEEDS).join(", ")}` })
      }
      const t = url.searchParams.get("t")
      if (url.searchParams.has("fixture") || t != null) {
        const at = t == null ? Infinity : Date.parse(t) / 1000
        if (Number.isNaN(at)) return sendJson(res, 400, { error: `t is not a time: "${t}"` })
        const path = findSnapshot(t == null ? [fixtures] : [recordings, fixtures], feed, at)
        if (path == null) return sendJson(res, 404, { error: `no snapshot of the ${feed} feed; run scripts/record-feeds.ts` })
        return sendJson(res, 200, simplifyFeed(feed, t == null ? "fixture" : "recorded", readFileSync(path)))
      }
      try {
        sendJson(res, 200, await live(feed))
      } catch (error) {
        sendJson(res, 502, { error: (error as Error).message })
      }
    },
  }
}

export default createMtaRoute()
