import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import type { BikeStationState, CityStateProvider, GarageState } from "../server/city-state.ts"
import { FIXTURE_CITY_STATE } from "../server/city-state-fixture.ts"
import {
  bikeFeedNotice,
  boltIsStale,
  cityStateFor,
  withinBudget,
  CityStateError,
  createLiveCityState,
  liveCityState,
  modeCityState,
  FEED_BUDGET_MS,
  PARKING_STALE_MS,
  parkingNotice,
  STALE_AFTER_MS,
  withoutStaleBolt,
} from "../server/city-state-live.ts"
import type { DecisionRequest, DecisionResponse } from "../server/decisions.ts"
import { ASK_DEADLINE_MS, AskError, createAskRoute, MIN_DECIDE_MS, untilAborted } from "../server/routes/ask.ts"
import { mergeBikeFeeds, reportedAt } from "../server/routes/bikes.ts"
import type { ParkingSnapshot } from "../server/routes/parking.ts"
import { SECTOR_NAMES } from "../src/layers/circulation.ts"
import { PLACES } from "../src/places.ts"

const NOW = Date.parse("2026-11-22T19:41:27.500Z")
const GARAGE: GarageState = {
  slug: "vrijdagmarkt",
  name: "Vrijdagmarkt",
  lat: 51.057134,
  lon: 3.726072,
  capacity: 602,
  available: 248,
  updated: "2026-11-22T19:40:00.000Z",
}
const DONKEY: BikeStationState = { operator: "donkey", id: "22589", name: "Belfortstraat 18", lat: 51.055301, lon: 3.726792, available: 2 }
const BOLT: BikeStationState = { operator: "bolt", id: "b-1", name: "Veldstraat", lat: 51.0525, lon: 3.7233, available: 4 }
const parking = async (): Promise<ParkingSnapshot> => ({ time: "2026-11-22T19:41:00Z", garages: [GARAGE] })
const bikesReported = (bolt: string | undefined) => async () => ({
  stations: [DONKEY, BOLT],
  reported: bolt == null ? {} : { bolt },
})
const fake = async (request: DecisionRequest): Promise<DecisionResponse> => {
  const question = request.questions[0]!
  if (question.type !== "choice") return { model: "fake", answers: [{ type: "predicate", name: question.name, probability: 0.9 }] }
  const first = question.choices[0]!.value
  return { model: "fake", answers: [{ type: "choice", name: question.name, choice: first, probabilities: [{ value: first, probability: 1 }], confidence: 1 }] }
}

describe("live city state", () => {
  test("fixture mode answers from T7's fixture state; live and recorded mode from the live provider", async () => {
    assert.equal(await modeCityState.current({ mode: "fixture", time: null }), FIXTURE_CITY_STATE)
    assert.equal(await modeCityState.current({ mode: "fixture", time: "2026-11-22T19:00:00Z" }), FIXTURE_CITY_STATE)
    const asked: string[] = []
    const live: CityStateProvider = {
      async current(options) {
        asked.push(options.mode)
        return { ...FIXTURE_CITY_STATE, time: "live" }
      },
    }
    const pick = cityStateFor(live)
    assert.equal((await pick.current({ mode: "fixture", time: null })).time, FIXTURE_CITY_STATE.time)
    assert.equal((await pick.current({ mode: "live", time: null })).time, "live")
    assert.equal((await pick.current({ mode: "recorded", time: null })).time, "live")
    assert.deepEqual(asked, ["live", "recorded"])
  })

  test("live mode merges the garages, bikes, sectors and places it is given, at now", async () => {
    const sources = { garages: parking, bikes: bikesReported(undefined), sectors: ["Kuip", "Krook"], places: PLACES.slice(0, 2), now: () => NOW }
    const state = await createLiveCityState(sources).current({ mode: "live", time: null })
    // Now, to the minute: the same question within a minute is the same request.
    assert.equal(state.time, "2026-11-22T19:41:00Z")
    assert.deepEqual(state.garages, [GARAGE])
    assert.deepEqual(state.bikes, [DONKEY, BOLT])
    assert.deepEqual(state.sectors, ["Kuip", "Krook"])
    assert.deepEqual(state.places, PLACES.slice(0, 2))
    assert.equal(state.notice, undefined)
  })

  test("sector names come from T3's SECTOR_NAMES, places from src/places.ts", async () => {
    const state = await createLiveCityState({ garages: parking, bikes: bikesReported(undefined), now: () => NOW }).current({ mode: "live", time: null })
    assert.deepEqual(state.sectors, [...SECTOR_NAMES])
    assert.equal(state.sectors[0], "Kuip", "the ask route says the first sector is the car-free core")
    assert.deepEqual(state.places, [...PLACES])
  })

  test("recorded mode reads the nearest parking snapshot and takes its time, with no network", async () => {
    const state = await liveCityState.current({ mode: "recorded", time: "2026-11-22T19:00:00Z" })
    assert.equal(state.time, "2026-11-22T19:00:06Z")
    assert.ok(state.garages.length > 0 && state.garages.some((g) => g.slug === "vrijdagmarkt"))
    assert.ok(state.bikes.length > 0)
    assert.deepEqual(state.sectors, [...SECTOR_NAMES])
  })

  test("Bolt availability more than an hour old is left out, and the answer says so", async () => {
    assert.equal(STALE_AFTER_MS, 60 * 60_000)
    assert.ok(boltIsStale("2026-07-17T08:25:15.000Z", NOW))
    assert.ok(!boltIsStale(new Date(NOW - 59 * 60_000).toISOString(), NOW))
    assert.ok(boltIsStale(new Date(NOW - 61 * 60_000).toISOString(), NOW))
    // A feed that gives no time cannot be judged, and is kept.
    assert.ok(!boltIsStale(undefined, NOW))
    assert.ok(!boltIsStale("soon", NOW))
    assert.deepEqual(withoutStaleBolt([DONKEY], "2026-07-17T08:25:15.000Z", NOW), { bikes: [DONKEY], notice: null })

    const at = (bolt: string | undefined) =>
      createLiveCityState({ garages: parking, bikes: bikesReported(bolt), now: () => NOW }).current({ mode: "live", time: null })
    const stale = await at("2026-07-17T08:25:15.000Z")
    assert.deepEqual(stale.bikes, [DONKEY])
    assert.equal(stale.notice, "Bolt bikes left out: their availability was last reported on 2026-07-17.")
    const fresh = await at(new Date(NOW - 5 * 60_000).toISOString())
    assert.deepEqual(fresh.bikes, [DONKEY, BOLT])
    assert.equal(fresh.notice, undefined)
    assert.deepEqual((await at(undefined)).bikes, [DONKEY, BOLT])

    // Through the ask route: no stale Bolt bike is offered, and the notice comes back.
    const route = createAskRoute({ provider: createLiveCityState({ garages: parking, bikes: bikesReported("2026-07-17T08:25:15Z"), now: () => NOW }), apiKey: () => "sk-test", decide: fake })
    const answer = await route.ask({ ask: "park:gravensteen", mode: "live", time: null })
    assert.ok(!answer.options.some((o) => o.value.startsWith("bikes:bolt:")), answer.options.map((o) => o.value).join(", "))
    assert.ok(answer.options.some((o) => o.value === "bikes:donkey:22589"))
    assert.match(answer.notice ?? "", /^Bolt bikes left out/)
    assert.equal(answer.dataTime, "2026-11-22T19:41:00Z")
  })

  test("the bike feed reports Bolt's newest last_reported, from POSIX seconds as text", () => {
    assert.equal(reportedAt("1773846081"), 1773846081_000)
    assert.equal(reportedAt(1773846081), 1773846081_000)
    assert.equal(reportedAt("2026-07-17T08:25:15Z"), Date.parse("2026-07-17T08:25:15Z"))
    for (const bad of [null, undefined, "", "soon", 0, -5]) assert.equal(reportedAt(bad), null, String(bad))
    const merged = mergeBikeFeeds({
      donkeyLocations: [],
      donkeyAvailability: [],
      bolt: [
        { station_id: "b-1", name: "Veldstraat", lat: 51.0525, lon: 3.7233, num_bikes_available: 1, last_reported: "1773846081" },
        { station_id: "b-2", name: "Korenmarkt", lat: 51.0542, lon: 3.722, num_bikes_available: 0, last_reported: "1784276715" },
        // Outside AREA: not a station of the map, so its time does not count.
        { station_id: "b-3", name: "Far away", lat: 50.9, lon: 3.5, num_bikes_available: 3, last_reported: "1800000000" },
      ],
      blueBike: [[], [], [], []],
    })
    assert.deepEqual(merged.reported, { bolt: new Date(1784276715_000).toISOString() })
    assert.deepEqual(mergeBikeFeeds({ donkeyLocations: [], donkeyAvailability: [], bolt: [], blueBike: [] }).reported, {})
  })

  test("without garages a parking question is a clear error and other questions still answer; a bike feed failure leaves the bikes out", async () => {
    const down = async (): Promise<ParkingSnapshot> => {
      throw new Error("parking feed answered 503 at some host")
    }
    const failing = createLiveCityState({ garages: down, bikes: bikesReported(undefined), now: () => NOW })
    const state = await failing.current({ mode: "live", time: null })
    assert.deepEqual(state.garages, [])
    assert.deepEqual(state.missing, { parking: "The parking feed did not answer." })
    assert.match(state.notice ?? "", /^Garages left out: the parking feed did not answer\./)
    const route = createAskRoute({ provider: failing, apiKey: () => "sk-test", decide: fake })
    for (const ask of ["busy:now", "park:gravensteen"]) {
      await assert.rejects(
        route.ask({ ask, mode: "live", time: null }),
        (e: AskError) => e instanceof AskError && e.status === 503 && e.message === "The parking feed did not answer. This question needs the garages: try again in a minute.",
      )
    }
    const drive = await route.ask({ ask: "drive:coupure~portus-ganda", mode: "live", time: null })
    assert.match(drive.notice ?? "", /^Garages left out/)
    // A provider that throws a CityStateError still passes its message on.
    const typed = createAskRoute({ provider: { current: () => Promise.reject(new CityStateError("The city's data is being updated.")) }, apiKey: () => "sk-test", decide: fake })
    await assert.rejects(typed.ask({ ask: "busy:now", mode: "live", time: null }), (e: AskError) => e.status === 502 && e.message === "The city's data is being updated.")
    // Any other provider error's message is not passed on (it may name a path).
    const leaky = createAskRoute({ provider: { current: () => Promise.reject(new Error("ENOENT: /srv/app/x.json")) }, apiKey: () => "sk-test", decide: fake })
    await assert.rejects(leaky.ask({ ask: "busy:now", mode: "live", time: null }), (e: AskError) => e.status === 502 && !e.message.includes("ENOENT"))

    const noRecording = createLiveCityState({ garages: async () => null, bikes: bikesReported(undefined), now: () => NOW })
    assert.deepEqual((await noRecording.current({ mode: "recorded", time: null })).missing, { parking: "There is no recorded parking data." })

    const bikesDown = async () => {
      throw new Error("timeout")
    }
    const allMissing = async () => ({ stations: [], feeds: { donkey: "missing", bolt: "missing", "blue-bike": "missing" } as const })
    for (const bikes of [bikesDown, allMissing]) {
      const state = await createLiveCityState({ garages: parking, bikes, now: () => NOW }).current({ mode: "live", time: null })
      assert.deepEqual(state.bikes, [])
      assert.deepEqual(state.garages, [GARAGE])
      assert.equal(state.notice, "Shared bikes left out: the bike feeds did not answer.")
    }
  })

  test("T7's fixture garage slugs are T5's parking fixture slugs", () => {
    const t5 = JSON.parse(readFileSync(new URL("../public/fixtures/parking.json", import.meta.url), "utf8")) as ParkingSnapshot
    const t5Slugs = t5.garages.map((g) => g.slug).sort()
    const t7Slugs = FIXTURE_CITY_STATE.garages.map((g) => g.slug).sort()
    for (const slug of t7Slugs) assert.ok(t5Slugs.includes(slug), `garage:${slug} is not in public/fixtures/parking.json`)
    assert.deepEqual(t7Slugs, t5Slugs)
  })
})

describe("data notices", () => {
  test("garages whose own feed time is more than 15 minutes old are named, in the question and the answer", async () => {
    assert.equal(PARKING_STALE_MS, 15 * 60_000)
    const fresh = { ...GARAGE, updated: new Date(NOW - 5 * 60_000).toISOString() }
    const old = { ...GARAGE, slug: "reep", name: "Reep", updated: new Date(NOW - 40 * 60_000).toISOString() }
    assert.equal(parkingNotice([fresh], NOW), null)
    assert.equal(parkingNotice([fresh, old], NOW), "Parking counts for Reep are more than 15 minutes old.")
    assert.match(parkingNotice([old], NOW) ?? "", /^Parking counts are more than 15 minutes old \(the oldest 40 minutes\)/)
    // A garage without a valid time is not judged.
    assert.equal(parkingNotice([{ ...GARAGE, updated: "" }], NOW), null)

    // The parking route keeps its last data when the feed fails: old counts come with the notice.
    const stale = async (): Promise<ParkingSnapshot> => ({ time: old.updated, garages: [old] })
    let asked = ""
    const route = createAskRoute({
      provider: createLiveCityState({ garages: stale, bikes: bikesReported(undefined), now: () => NOW }),
      apiKey: () => "sk-test",
      decide: async (request) => {
        asked = JSON.stringify(request)
        return fake(request)
      },
    })
    const answer = await route.ask({ ask: "park:gravensteen", mode: "live", time: null })
    assert.match(answer.notice ?? "", /^Parking counts are more than 15 minutes old/)
    assert.match(asked, /About this data: Parking counts are more than 15 minutes old/)
  })

  test("every bike operator whose feed failed or answered in part is named, even when another answered", async () => {
    assert.equal(bikeFeedNotice({ donkey: "ok", bolt: "ok", "blue-bike": "ok" }), null)
    assert.equal(bikeFeedNotice(undefined), null)
    assert.equal(
      bikeFeedNotice({ donkey: "missing", bolt: "missing", "blue-bike": "ok" }),
      "Donkey Republic bikes left out: its feed did not answer. Bolt bikes left out: its feed did not answer.",
    )
    assert.equal(bikeFeedNotice({ donkey: "partial" }), "Donkey Republic's availability did not answer: its stations count as empty.")
    assert.equal(bikeFeedNotice({ "blue-bike": "partial" }), "Blue-bike bikes in part: some of its feeds did not answer.")

    const state = await createLiveCityState({
      garages: parking,
      bikes: async () => ({ stations: [], feeds: { donkey: "missing", bolt: "missing", "blue-bike": "ok" } }),
      now: () => NOW,
    }).current({ mode: "live", time: null })
    assert.match(state.notice ?? "", /Donkey Republic bikes left out.*Bolt bikes left out/)
  })
})

// One deadline per question (T9b): small budgets here, so the tests run in well under a
// second; the real ones are 7 s for the question and 2.5 s per feed.
describe("one deadline for a question", () => {
  const DEADLINE = 300
  const BUDGET = 40
  const never = <T>() => new Promise<T>(() => {})
  const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))
  const counting = () => {
    const calls: AbortSignal[] = []
    const decide = async (request: DecisionRequest, options: { signal: AbortSignal }) => {
      calls.push(options.signal)
      return fake(request)
    }
    return { calls, decide }
  }
  const timed = async <T>(run: () => Promise<T>): Promise<{ ms: number; result: PromiseSettledResult<T> }> => {
    const t0 = performance.now()
    const [result] = await Promise.allSettled([run()])
    return { ms: performance.now() - t0, result: result! }
  }

  test("the real deadline leaves the panel a second, and each feed's budget leaves the Decisions API most of it", () => {
    assert.equal(ASK_DEADLINE_MS, 7_000)
    assert.ok(ASK_DEADLINE_MS + 1_000 <= 8_000, "the panel (src/ask/panel.ts) waits 8 s")
    assert.equal(FEED_BUDGET_MS, 2_500)
    assert.ok(ASK_DEADLINE_MS - FEED_BUDGET_MS >= 4 * MIN_DECIDE_MS)
  })

  test("a stalled bike feed (never answers) is left out and the question is answered within the budget", async () => {
    const { calls, decide } = counting()
    const provider = createLiveCityState({ garages: parking, bikes: never, now: () => NOW, feedBudgetMs: BUDGET })
    const route = createAskRoute({ provider, apiKey: () => "sk-test", decide, timeoutMs: DEADLINE })
    const { ms, result } = await timed(() => route.ask({ ask: "park:gravensteen", mode: "live", time: null }))
    assert.equal(result.status, "fulfilled")
    const answer = (result as PromiseFulfilledResult<Awaited<ReturnType<typeof route.ask>>>).value
    assert.equal(answer.notice, `Shared bikes left out: the bike feeds did not answer within ${BUDGET / 1000} s.`)
    assert.ok(!answer.options.some((o) => o.value.startsWith("bikes:")))
    assert.equal(calls.length, 1)
    assert.ok(ms < BUDGET + 100, `${ms} ms`)
  })

  test("a slow feed (answers after its budget) is left out; slow parking makes a parking question a clear error in time", async () => {
    const slowBikes = () => later(BUDGET * 3, { stations: [DONKEY, BOLT] })
    const state = await createLiveCityState({ garages: parking, bikes: slowBikes, now: () => NOW, feedBudgetMs: BUDGET }).current({ mode: "live", time: null })
    assert.deepEqual(state.bikes, [])
    assert.deepEqual(state.garages, [GARAGE])

    const { calls, decide } = counting()
    const slowParking = () => later(BUDGET * 3, { time: "2026-11-22T19:41:00Z", garages: [GARAGE] })
    const provider = createLiveCityState({ garages: slowParking, bikes: bikesReported(undefined), now: () => NOW, feedBudgetMs: BUDGET })
    const route = createAskRoute({ provider, apiKey: () => "sk-test", decide, timeoutMs: DEADLINE })
    const { ms, result } = await timed(() => route.ask({ ask: "park:gravensteen", mode: "live", time: null }))
    assert.equal(result.status, "rejected")
    const error = (result as PromiseRejectedResult).reason as AskError
    assert.equal(error.status, 503)
    assert.equal(error.message, `The parking feed did not answer within ${BUDGET / 1000} s. This question needs the garages: try again in a minute.`)
    assert.equal(calls.length, 0, "no paid call for a question that cannot be answered")
    assert.ok(ms < DEADLINE, `${ms} ms`)
    // A question that does not need the garages is still answered, with the notice.
    const drive = await route.ask({ ask: "drive:coupure~portus-ganda", mode: "live", time: null })
    assert.match(drive.notice ?? "", /^Garages left out: the parking feed did not answer within/)
  })

  test("a failed feed is left out at once, with the notice", async () => {
    const { decide } = counting()
    const failing = () => Promise.reject(new Error("socket hang up"))
    const route = createAskRoute({
      provider: createLiveCityState({ garages: parking, bikes: failing, now: () => NOW, feedBudgetMs: BUDGET }),
      apiKey: () => "sk-test",
      decide,
      timeoutMs: DEADLINE,
    })
    const { ms, result } = await timed(() => route.ask({ ask: "park:gravensteen", mode: "live", time: null }))
    assert.equal(result.status, "fulfilled")
    assert.equal((result as PromiseFulfilledResult<{ notice?: string }>).value.notice, "Shared bikes left out: the bike feeds did not answer.")
    assert.ok(ms < BUDGET, `${ms} ms`)
  })

  test("a city state that never arrives ends at the deadline, and no Decisions call starts, then or later", async () => {
    const { calls, decide } = counting()
    let late: () => void = () => {}
    const provider = { current: () => new Promise<typeof FIXTURE_CITY_STATE>((resolve) => (late = () => resolve(FIXTURE_CITY_STATE))) }
    const route = createAskRoute({ provider, apiKey: () => "sk-test", decide, timeoutMs: DEADLINE })
    const { ms, result } = await timed(() => route.ask({ ask: "busy:now", mode: "live", time: null }))
    assert.equal(result.status, "rejected")
    assert.equal(((result as PromiseRejectedResult).reason as AskError).status, 504)
    assert.ok(ms >= DEADLINE - 5 && ms < DEADLINE + 100, `${ms} ms`)
    late()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls.length, 0)
  })

  test("with too little time left after reading the city, the Decisions call is not started", async () => {
    const { calls, decide } = counting()
    const provider = { current: () => later(DEADLINE - 20, FIXTURE_CITY_STATE) }
    const route = createAskRoute({ provider, apiKey: () => "sk-test", decide, timeoutMs: DEADLINE, minDecideMs: 50 })
    await assert.rejects(route.ask({ ask: "busy:now", mode: "live", time: null }), (e: AskError) => e.status === 504 && /took too long/.test(e.message))
    assert.equal(calls.length, 0)
  })

  test("a client that stops waiting gets no Decisions call, and one in flight is aborted", async () => {
    const { calls, decide } = counting()
    const gone = new AbortController()
    const provider = { current: () => later(30, FIXTURE_CITY_STATE) }
    const route = createAskRoute({ provider, apiKey: () => "sk-test", decide, timeoutMs: DEADLINE })
    const asked = route.ask({ ask: "busy:now", mode: "live", time: null }, { signal: gone.signal })
    gone.abort()
    await assert.rejects(asked, (e: AskError) => e.status === 499)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(calls.length, 0)

    const seen: { signal?: AbortSignal } = {}
    const hanging = (_request: DecisionRequest, options: { signal: AbortSignal }) => {
      seen.signal = options.signal
      return never<DecisionResponse>()
    }
    const leaving = new AbortController()
    const inFlight = createAskRoute({ apiKey: () => "sk-test", decide: hanging, timeoutMs: DEADLINE })
    const pending = inFlight.ask({ ask: "busy:now" }, { signal: leaving.signal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(seen.signal != null && !seen.signal.aborted)
    leaving.abort()
    await assert.rejects(pending, (e: AskError) => e.status === 499)
    assert.ok(seen.signal.aborted, "the call in flight is aborted")
    assert.equal((seen.signal.reason as AskError).status, 499)
  })

  test("a question already over reads nothing, and work nobody waits for never rejects unhandled", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      let reads = 0
      const counted = <T>(value: T) => async () => {
        reads++
        return value
      }
      const provider = createLiveCityState({ garages: counted({ time: "2026-11-22T19:41:00Z", garages: [GARAGE] }), bikes: counted({ stations: [] }), now: () => NOW })
      const { calls, decide } = counting()
      const route = createAskRoute({ provider, apiKey: () => "sk-test", decide, timeoutMs: DEADLINE })
      await assert.rejects(route.ask({ ask: "park:gravensteen", mode: "live", time: null }, { signal: AbortSignal.abort() }), (e: AskError) => e.status === 499)
      await assert.rejects(provider.current({ mode: "live", time: null, signal: AbortSignal.abort() }))
      assert.equal(reads, 0)
      assert.equal(calls.length, 0)

      // Work handed over after the wait has ended still has its failure handled.
      const failsLater = () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late failure")), 5))
      await assert.rejects(untilAborted(failsLater(), AbortSignal.abort()))
      await assert.rejects(withinBudget(failsLater(), BUDGET, AbortSignal.abort()))
      const gone = new AbortController()
      const waiting = untilAborted(failsLater(), gone.signal)
      gone.abort()
      await assert.rejects(waiting)
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.deepEqual(unhandled, [])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("without a key, a recorded answer whose file does not arrive ends at the deadline", { skip: process.platform === "win32" }, async () => {
    // A named pipe nobody writes to: reading it waits until someone does.
    const dir = mkdtempSync(join(tmpdir(), "ghent-live-fifo-"))
    const fifo = join(dir, "recordings.json")
    if (spawnSync("mkfifo", [fifo]).status !== 0) return
    try {
      const route = createAskRoute({ apiKey: () => undefined, recordingsFile: fifo, timeoutMs: DEADLINE })
      const { ms, result } = await timed(() => route.ask({ ask: "busy:now" }))
      assert.equal(result.status, "rejected")
      assert.equal(((result as PromiseRejectedResult).reason as AskError).status, 504)
      assert.ok(ms < DEADLINE + 100, `${ms} ms`)
    } finally {
      // Let the pending read finish, so nothing is left open.
      writeFileSync(fifo, "{}")
      await new Promise((resolve) => setTimeout(resolve, 10))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a call two requests share goes on while one of them waits, and stops when the last one leaves", async () => {
    const shared: { signal?: AbortSignal } = {}
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const decide = async (request: DecisionRequest, options: { signal: AbortSignal }) => {
      calls++
      shared.signal = options.signal
      await gate
      return fake(request)
    }
    const route = createAskRoute({ apiKey: () => "sk-test", decide, timeoutMs: DEADLINE })
    const first = new AbortController()
    const a = route.ask({ ask: "busy:now" }, { signal: first.signal })
    const b = route.ask({ ask: "busy:now" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    first.abort()
    await assert.rejects(a, (e: AskError) => e.status === 499)
    assert.ok(shared.signal != null && !shared.signal.aborted, "the other request still waits for it")
    release()
    assert.equal((await b).answer, "Yes")
    assert.equal(calls, 1)

    const both = [new AbortController(), new AbortController()]
    const last: { signal?: AbortSignal } = {}
    let hangCalls = 0
    const hang = createAskRoute({
      apiKey: () => "sk-test",
      decide: (_r, o) => {
        hangCalls++
        last.signal = o.signal
        return never<DecisionResponse>()
      },
      timeoutMs: DEADLINE,
    })
    const waits = both.map((c) => hang.ask({ ask: "busy:now" }, { signal: c.signal }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    both[0]!.abort()
    assert.ok(last.signal != null && !last.signal.aborted)
    both[1]!.abort()
    await Promise.allSettled(waits)
    assert.ok(last.signal.aborted, "aborted once nobody waits")
    // The next request starts a new call rather than joining the aborted one.
    const third = new AbortController()
    const again = hang.ask({ ask: "busy:now" }, { signal: third.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(hangCalls, 2)
    third.abort()
    await assert.rejects(again)
  })
})

// test/fixtures/stage.png is the Street-level preset at night with a parking question
// (checks/stage.json's "view") on the integrated app, and test/recordings/ holds the
// Decisions API's real answers for it, so CI re-checks it with no key and no network.
describe("stage view", () => {
  test("the recorded stage screenshot passes checks/stage.json", () => {
    const env = { ...process.env }
    delete env.OPENAI_API_KEY
    const run = spawnSync(
      process.execPath,
      ["scripts/check-visual.ts", "test/fixtures/stage.png", "checks/stage.json", "--replay"],
      { encoding: "utf8", env },
    )
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout.match(/^PASS /gm)?.length, 3, run.stdout)
  })

  test("checks/stage.json describes the Street-level preset at night with a parking question", () => {
    const checks = JSON.parse(readFileSync("checks/stage.json", "utf8")) as { view: string; checks: Array<{ min?: number }> }
    const view = new URLSearchParams(checks.view.replace(/^#/, ""))
    assert.equal(view.get("light"), "night")
    assert.equal(view.get("ask"), "park:gravensteen")
    assert.ok(checks.checks.every((c) => (c.min ?? 0) >= 0.8))
  })
})
