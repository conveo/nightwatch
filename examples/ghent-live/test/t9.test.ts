import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"
import type { BikeStationState, CityStateProvider, GarageState } from "../server/city-state.ts"
import { FIXTURE_CITY_STATE } from "../server/city-state-fixture.ts"
import {
  boltIsStale,
  cityStateFor,
  CityStateError,
  createLiveCityState,
  liveCityState,
  modeCityState,
  STALE_AFTER_MS,
  withoutStaleBolt,
} from "../server/city-state-live.ts"
import type { DecisionRequest, DecisionResponse } from "../server/decisions.ts"
import { AskError, createAskRoute } from "../server/routes/ask.ts"
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

  test("a parking feed failure is a 502 the route already handles; a bike feed failure leaves the bikes out", async () => {
    const down = async (): Promise<ParkingSnapshot> => {
      throw new Error("parking feed answered 503 at some host")
    }
    const failing = createLiveCityState({ garages: down, bikes: bikesReported(undefined), now: () => NOW })
    await assert.rejects(failing.current({ mode: "live", time: null }), (e: Error) => e instanceof CityStateError)
    const route = createAskRoute({ provider: failing, apiKey: () => "sk-test", decide: fake })
    await assert.rejects(
      route.ask({ ask: "busy:now", mode: "live", time: null }),
      (e: AskError) => e instanceof AskError && e.status === 502 && e.message === "The parking feed did not answer.",
    )
    // Any other provider error's message is not passed on (it may name a path).
    const leaky = createAskRoute({ provider: { current: () => Promise.reject(new Error("ENOENT: /srv/app/x.json")) }, apiKey: () => "sk-test", decide: fake })
    await assert.rejects(leaky.ask({ ask: "busy:now", mode: "live", time: null }), (e: AskError) => e.status === 502 && !e.message.includes("ENOENT"))

    const noRecording = createLiveCityState({ garages: async () => null, bikes: bikesReported(undefined), now: () => NOW })
    await assert.rejects(noRecording.current({ mode: "recorded", time: null }), /no recorded parking data/)

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
