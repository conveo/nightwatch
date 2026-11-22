import { SECTOR_NAMES } from "../src/layers/circulation.ts"
import { PLACES, type Place } from "../src/places.ts"
import type { BikeStationState, CityState, CityStateProvider } from "./city-state.ts"
import { fixtureCityState } from "./city-state-fixture.ts"
import { bikeAnswer, type BikesAnswer } from "./routes/bikes.ts"
import { parkingSnapshot, type ParkingSnapshot } from "./routes/parking.ts"

// The city state "ask Ghent" (T7) reads in live and recorded mode, from the routes
// the layers read: T5's garages (server/routes/parking.ts), T6's shared-bike stations
// (server/routes/bikes.ts), T3's sector names (src/layers/circulation.ts, whose top
// half imports in Node without a DOM) and the base's places (src/places.ts). Fixture
// mode keeps T7's fixture state, so the committed recordings keep answering offline.
//
// - time: now in live mode (to the minute, so the same question within a minute is
//   the same request and the ask route's cache and in-flight sharing still work);
//   the recorded snapshot's time in recorded mode.
// - garages: a parking feed that fails with nothing cached is an error the ask route
//   answers with a 502; an answer about parking without garages would mislead.
// - bikes: a bike feed that fails leaves the bikes out, and the answer says so.
// - Bolt: its feed has been months behind. When the newest time a Bolt station in the
//   area reported is more than an hour before the state's time, Bolt's stations are
//   left out, so no answer sends anyone to a bike that may not be there.

type Options = Parameters<CityStateProvider["current"]>[0]

// A CityState with an optional line about its data, which the ask route returns as
// the answer's `notice`. CityState itself (server/city-state.ts) stays as it is.
export type LiveCityState = CityState & { notice?: string }
export type LiveCityStateProvider = { current(options: Options): Promise<LiveCityState> }

// An error whose message is fit for the browser (it names no path, host or key).
export class CityStateError extends Error {}

// Availability older than this is not trusted.
export const STALE_AFTER_MS = 60 * 60_000

export type LiveSources = {
  garages?: (options: Options) => Promise<ParkingSnapshot | null>
  bikes?: (options: Options) => Promise<Pick<BikesAnswer, "stations"> & Partial<Pick<BikesAnswer, "feeds" | "reported">>>
  sectors?: readonly string[]
  places?: readonly Place[]
  now?: () => number
  staleAfterMs?: number
}

// Bolt's availability is stale when the newest time one of its stations reported is
// more than `maxAgeMs` before `at`. A feed that gives no time cannot be judged, and is
// kept as it is.
export function boltIsStale(reported: string | undefined, at: number, maxAgeMs = STALE_AFTER_MS): boolean {
  const t = reported == null ? Number.NaN : Date.parse(reported)
  return !Number.isNaN(t) && at - t > maxAgeMs
}

// The stations to offer: without Bolt's when its availability is stale, with the line
// that says so.
export function withoutStaleBolt(
  bikes: readonly BikeStationState[],
  reported: string | undefined,
  at: number,
  maxAgeMs = STALE_AFTER_MS,
): { bikes: BikeStationState[]; notice: string | null } {
  if (!bikes.some((b) => b.operator === "bolt") || !boltIsStale(reported, at, maxAgeMs)) return { bikes: [...bikes], notice: null }
  const day = new Date(Date.parse(reported!)).toISOString().slice(0, 10)
  return {
    bikes: bikes.filter((b) => b.operator !== "bolt"),
    notice: `Bolt bikes left out: their availability was last reported on ${day}.`,
  }
}

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

export function createLiveCityState(sources: LiveSources = {}): LiveCityStateProvider {
  const garages = sources.garages ?? parkingSnapshot
  const bikes = sources.bikes ?? bikeAnswer
  const sectors = sources.sectors ?? SECTOR_NAMES
  const places = sources.places ?? PLACES
  const now = sources.now ?? Date.now

  return {
    async current(options) {
      const [parking, bikeData] = await Promise.all([
        garages(options).catch((error: unknown) => {
          throw new CityStateError("The parking feed did not answer.", { cause: error })
        }),
        bikes(options).catch(() => null),
      ])
      if (parking == null) throw new CityStateError("There is no recorded parking data.")
      const time = options.mode === "live" ? isoSeconds(Math.floor(now() / 60_000) * 60_000) : parking.time
      const notices: string[] = []

      let stations: BikeStationState[] = []
      const feeds = bikeData?.feeds == null ? [] : Object.values(bikeData.feeds)
      if (bikeData == null || (feeds.length > 0 && feeds.every((f) => f === "missing"))) {
        notices.push("Shared bikes left out: the bike feeds did not answer.")
      } else {
        const at = options.mode === "live" ? now() : Date.parse(time)
        const kept = withoutStaleBolt(bikeData.stations, bikeData.reported?.bolt, at, sources.staleAfterMs)
        stations = kept.bikes
        if (kept.notice != null) notices.push(kept.notice)
      }

      return {
        time,
        garages: parking.garages,
        bikes: stations,
        sectors: [...sectors],
        places: [...places],
        ...(notices.length === 0 ? {} : { notice: notices.join(" ") }),
      }
    },
  }
}

export const liveCityState = createLiveCityState()

// The provider for a mode: fixture mode answers from `fixture` (T7's), live and
// recorded mode from `live`.
export function cityStateFor(
  live: LiveCityStateProvider = liveCityState,
  fixture: CityStateProvider = fixtureCityState,
): LiveCityStateProvider {
  return { current: (options) => (options.mode === "fixture" ? fixture : live).current(options) }
}

// What the ask route reads by default.
export const modeCityState = cityStateFor()
