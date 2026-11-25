import { SECTOR_NAMES } from "../src/layers/circulation.ts"
import { PLACES, type Place } from "../src/places.ts"
import type { BikeStationState, CityState, CityStateProvider, GarageState } from "./city-state.ts"
import { fixtureCityState } from "./city-state-fixture.ts"
import { bikeAnswer, OPERATORS, type BikeOperator, type BikesAnswer, type FeedStatus } from "./routes/bikes.ts"
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
// - feeds: each feed (parking, bikes) gets at most FEED_BUDGET_MS, inside the ask
//   route's deadline for the whole question; a feed that fails or is slower is left
//   out and the notice says so, so one stalled feed does not sink a question the
//   others can answer. Its request goes on and fills its route's cache for later.
// - missing parts: without the garages (the parking feed failed, was too slow, or
//   listed none, or there is no recorded snapshot) or without the bike stations (the
//   bike feeds failed or were too slow, or recorded mode, which has no recorded bike
//   data), the state says why in `missing`; the ask route answers a question that
//   needs that part with the reason (server/routes/ask.ts, NEEDS), and any other
//   question without it, with the notice.
// - parking age: the parking route keeps its last data when the feed fails, so a
//   garage's own feed time can lag; garages more than 15 minutes behind the state's
//   time are named in a notice, which goes into the question and the answer.
// - bikes: a bike feed that fails leaves its operator out, and the answer says so.
// - Bolt: its feed has been months behind. When the newest time a Bolt station in the
//   area reported is more than an hour before the state's time, Bolt's stations are
//   left out, so no answer sends anyone to a bike that may not be there.

// The ask route passes its deadline's signal: when it aborts (the deadline passed or
// the client hung up), the state is not waited for any longer.
type Options = Parameters<CityStateProvider["current"]>[0] & { signal?: AbortSignal }

// A CityState with an optional line about its data, which the ask route returns as
// the answer's `notice`, and the reason the garages are missing, if they are.
// CityState itself (server/city-state.ts) stays as it is.
export type LiveCityState = CityState & { notice?: string; missing?: { parking?: string; bikes?: string } }
export type LiveCityStateProvider = { current(options: Options): Promise<LiveCityState> }

// An error whose message is fit for the browser (it names no path, host or key).
export class CityStateError extends Error {}

// Availability older than this is not trusted.
export const STALE_AFTER_MS = 60 * 60_000

// Each feed gets at most this long; the ask route's whole deadline is 7 s, so even with
// both feeds at their limit the Decisions API keeps more than 4 s.
export const FEED_BUDGET_MS = 2_500

type Read<T> = { ok: true; value: T } | { ok: false; late: boolean }

// `work` within `ms`, or why not: it failed, or it was late. When `signal` aborts first
// (the whole question's deadline, or the client went), that reason is thrown instead.
export function withinBudget<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<Read<T>> {
  // The work's failure is always handled, also when nobody waits for it any more.
  work.catch(() => {})
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise<Read<T>>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", stop)
    }
    const stop = (): void => {
      finish()
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      finish()
      resolve({ ok: false, late: true })
    }, ms)
    signal?.addEventListener("abort", stop, { once: true })
    work.then(
      (value) => {
        finish()
        resolve({ ok: true, value })
      },
      () => {
        finish()
        resolve({ ok: false, late: false })
      },
    )
  })
}

export type LiveSources = {
  garages?: (options: Options) => Promise<ParkingSnapshot | null>
  bikes?: (options: Options) => Promise<Pick<BikesAnswer, "stations"> & Partial<Pick<BikesAnswer, "feeds" | "reported">>>
  sectors?: readonly string[]
  places?: readonly Place[]
  now?: () => number
  staleAfterMs?: number
  feedBudgetMs?: number
}

// Parking counts older than this, by each garage's own feed time, are named as old (the
// parking layer's own notice uses the same 15 minutes).
export const PARKING_STALE_MS = 15 * 60_000

// The line that names garages whose counts are more than `maxAgeMs` old at `at`, or
// null when every garage is current. A garage without a valid time is not judged.
export function parkingNotice(garages: readonly GarageState[], at: number, maxAgeMs = PARKING_STALE_MS): string | null {
  const stale = garages.filter((g) => {
    const t = Date.parse(g.updated)
    return !Number.isNaN(t) && at - t > maxAgeMs
  })
  if (stale.length === 0) return null
  const oldest = Math.min(...stale.map((g) => Date.parse(g.updated)))
  const minutes = Math.round((at - oldest) / 60_000)
  if (stale.length === garages.length) {
    return `Parking counts are more than ${Math.round(maxAgeMs / 60_000)} minutes old (the oldest ${minutes} minutes): the parking feed may be down.`
  }
  const names = stale.slice(0, 3).map((g) => g.name)
  const more = stale.length > 3 ? ` and ${stale.length - 3} more` : ""
  return `Parking counts for ${names.join(", ")}${more} are more than ${Math.round(maxAgeMs / 60_000)} minutes old.`
}

const OPERATOR_NAMES: Record<BikeOperator, string> = { donkey: "Donkey Republic", bolt: "Bolt", "blue-bike": "Blue-bike" }

// The line that names every bike operator whose feed failed ("missing") or answered
// only in part, or null when all answered. Without Donkey Republic's availability its
// stations count as empty, which an answer must not read as a shortage.
export function bikeFeedNotice(feeds: Partial<Record<BikeOperator, FeedStatus>> | undefined): string | null {
  if (feeds == null) return null
  const lines: string[] = []
  for (const operator of OPERATORS) {
    const status = feeds[operator]
    if (status == null || status === "ok") continue
    const name = OPERATOR_NAMES[operator]
    if (status === "missing") lines.push(`${name} bikes left out: its feed did not answer.`)
    else if (operator === "donkey") lines.push(`${name}'s availability did not answer: its stations count as empty.`)
    else lines.push(`${name} bikes in part: some of its feeds did not answer.`)
  }
  return lines.length === 0 ? null : lines.join(" ")
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
      // A question that is already over does not start the feeds' requests.
      if (options.signal?.aborted) throw options.signal.reason
      const budget = sources.feedBudgetMs ?? FEED_BUDGET_MS
      const seconds = `${budget / 1000} s`
      // Both feeds at once, each within its budget; a reason to stop (the deadline, a
      // client that went) ends the wait for both.
      const [parkingRead, bikeRead] = await Promise.all([
        withinBudget(Promise.resolve().then(() => garages(options)), budget, options.signal),
        withinBudget(Promise.resolve().then(() => bikes(options)), budget, options.signal),
      ])
      const parking = parkingRead.ok ? parkingRead.value : null
      const missingParking =
        parking != null
          ? parking.garages.length > 0
            ? null
            : options.mode === "recorded"
              ? "The recorded parking snapshot lists no garages."
              : "The parking feed listed no garages."
          : parkingRead.ok
            ? "There is no recorded parking data."
            : parkingRead.late
              ? `The parking feed did not answer within ${seconds}.`
              : "The parking feed did not answer."
      const time =
        options.mode === "live"
          ? isoSeconds(Math.floor(now() / 60_000) * 60_000)
          : (parking?.time ?? options.time ?? isoSeconds(now()))
      const at = options.mode === "live" ? now() : Date.parse(time)
      const notices: string[] = []
      if (missingParking != null) notices.push(`Garages left out: ${missingParking.charAt(0).toLowerCase()}${missingParking.slice(1)}`)
      const oldParking = parking == null ? null : parkingNotice(parking.garages, at)
      if (oldParking != null) notices.push(oldParking)

      let stations: BikeStationState[] = []
      let missingBikes: string | null = null
      const bikeData = bikeRead.ok ? bikeRead.value : null
      const feeds = bikeData?.feeds == null ? [] : Object.values(bikeData.feeds)
      if (options.mode === "recorded") {
        // The bikes route answers recorded mode with its committed sample, not with the
        // stations at the recorded time: that is no data about this moment.
        missingBikes = "There is no recorded bike data."
        notices.push("Shared bikes left out: there is no recorded bike data.")
      } else if (!bikeRead.ok && bikeRead.late) {
        missingBikes = `The bike feeds did not answer within ${seconds}.`
        notices.push(`Shared bikes left out: the bike feeds did not answer within ${seconds}.`)
      } else if (bikeData == null || (feeds.length > 0 && feeds.every((f) => f === "missing"))) {
        missingBikes = "The bike feeds did not answer."
        notices.push("Shared bikes left out: the bike feeds did not answer.")
      } else {
        const failed = bikeFeedNotice(bikeData.feeds)
        if (failed != null) notices.push(failed)
        const kept = withoutStaleBolt(bikeData.stations, bikeData.reported?.bolt, at, sources.staleAfterMs)
        stations = kept.bikes
        if (kept.notice != null) notices.push(kept.notice)
      }

      return {
        time,
        garages: parking?.garages ?? [],
        bikes: stations,
        sectors: [...sectors],
        places: [...places],
        ...(notices.length === 0 ? {} : { notice: notices.join(" ") }),
        ...(missingParking == null && missingBikes == null
          ? {}
          : {
              missing: {
                ...(missingParking == null ? {} : { parking: missingParking }),
                ...(missingBikes == null ? {} : { bikes: missingBikes }),
              },
            }),
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
