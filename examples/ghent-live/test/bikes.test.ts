import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { test } from "node:test"
import { Color, type InstancedMesh, Raycaster, Vector3 } from "three"
import { loadRoutes } from "../server/api.ts"
import {
  bikeStations,
  bikesAvailable,
  createBikeFeed,
  FEED_URLS,
  FIXTURE_PATH,
  mergeBikeFeeds,
  type BikesAnswer,
  type RawFeeds,
} from "../server/routes/bikes.ts"
import { FIXTURE_RADIUS_M } from "../src/constants.ts"
import { toLocal } from "../src/geo.ts"
import {
  BAR_WIDTH_M,
  barHeight,
  bikesNotice,
  createBikesLayer,
  EMPTY_BAR_M,
  MAX_BAR_M,
  OPERATOR_COLORS,
  parseBikesAnswer,
  stationKey,
} from "../src/layers/bikes.ts"

const NO_FEEDS: RawFeeds = { donkeyLocations: [], donkeyAvailability: [], bolt: [], blueBike: [[], [], [], []] }
const KORENMARKT = { station_id: "12022", name: "Korenmarkt", lat: 51.054192, lon: 3.722011 }
const STOPENBERGHE = { station_id: "12018", name: "Jan van Stopenberghestraat 2", lat: 51.053549, lon: 3.721223 }
const fixture = (): BikesAnswer => JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as BikesAnswer

test("a Donkey Republic station without availability shows 0 bikes, not an error", () => {
  const { stations, feeds } = mergeBikeFeeds({
    ...NO_FEEDS,
    donkeyLocations: [KORENMARKT, STOPENBERGHE],
    donkeyAvailability: [{ station_id: "12018", num_bikes_available: 2, is_renting: 1 }],
  })
  assert.deepEqual(
    stations.map((s) => [s.id, s.available]),
    [
      ["12018", 2],
      ["12022", 0],
    ],
  )
  assert.equal(feeds.donkey, "ok")
})

test("bikes available: a whole number, 0 when malformed, negative or not renting", () => {
  assert.equal(bikesAvailable(3, 1), 3)
  assert.equal(bikesAvailable("2"), 2)
  assert.equal(bikesAvailable(2.7), 2)
  assert.equal(bikesAvailable(3, 0), 0)
  assert.equal(bikesAvailable(3, "0"), 0)
  for (const bad of [-1, null, undefined, "", "many", Number.NaN]) assert.equal(bikesAvailable(bad), 0)
})

test("all three operators merge into the CityState shape, inside AREA only", () => {
  const { stations, feeds } = mergeBikeFeeds({
    donkeyLocations: [KORENMARKT, { station_id: "99", name: "Far away", lat: 51.1, lon: 3.7 }],
    donkeyAvailability: [{ station_id: "12022", num_bikes_available: 4, is_renting: 1 }],
    bolt: [
      { station_id: "b-1", name: "Veldstraat", lat: 51.0525, lon: 3.7233, num_bikes_available: 3, is_renting: 1 },
      // The same station twice, one without coordinates and one without a name.
      { station_id: "b-1", name: "Veldstraat again", lat: 51.0525, lon: 3.7233, num_bikes_available: 9 },
      { station_id: "b-2", name: "Nowhere", lat: null, lon: 3.72, num_bikes_available: 1 },
      { station_id: "b-3", lat: 51.055, lon: 3.725, num_bikes_available: 0 },
    ],
    // Blue-bike's ids are numbers and its coordinates strings.
    blueBike: [
      [{ id: 72, name: "Gent-Dampoort Station", bikes_available: 56, latitude: "51.056083", longitude: "3.740194" }],
      [{ id: 500, name: "In the centre", bikes_available: 12, latitude: "51.0537", longitude: "3.7250" }],
      [],
      [],
    ],
  })
  assert.deepEqual(stations, [
    { operator: "donkey", id: "12022", name: "Korenmarkt", lat: 51.054192, lon: 3.722011, available: 4 },
    { operator: "bolt", id: "b-1", name: "Veldstraat", lat: 51.0525, lon: 3.7233, available: 3 },
    { operator: "bolt", id: "b-3", name: "b-3", lat: 51.055, lon: 3.725, available: 0 },
    { operator: "blue-bike", id: "500", name: "In the centre", lat: 51.0537, lon: 3.725, available: 12 },
  ])
  assert.deepEqual(feeds, { donkey: "ok", bolt: "ok", "blue-bike": "ok" })
})

test("a dataset that fails does not break the others, and its operator is reported", async () => {
  const answers = new Map<string, unknown>([
    [FEED_URLS.donkeyLocations, [KORENMARKT]],
    [FEED_URLS.donkeyAvailability, [{ station_id: "12022", num_bikes_available: 1 }]],
    [FEED_URLS.blueBike[0]!, [{ id: 500, name: "In the centre", bikes_available: 2, latitude: "51.0537", longitude: "3.725" }]],
    // Not a list: an error page that is valid JSON.
    [FEED_URLS.blueBike[1]!, { error_code: "ODSQLError" }],
    [FEED_URLS.blueBike[2]!, []],
    [FEED_URLS.blueBike[3]!, []],
  ])
  const feed = createBikeFeed({
    fetchJson: async (url) => {
      if (!answers.has(url)) throw new Error("HTTP 503")
      return answers.get(url)
    },
    now: () => Date.parse("2026-11-22T19:00:00Z"),
  })
  const answer = await feed.current()
  assert.equal(answer.time, "2026-11-22T19:00:00.000Z")
  assert.deepEqual(
    answer.stations.map((s) => stationKey(s)),
    ["bikes:donkey:12022", "bikes:blue-bike:500"],
  )
  assert.deepEqual(answer.feeds, { donkey: "ok", bolt: "missing", "blue-bike": "partial" })
  assert.equal(bikesNotice(answer, "live", Date.parse(answer.time)), "Shared bikes: no Bolt data, Blue-bike data incomplete")
})

test("a malformed item in a feed is skipped; the rest of that feed and the others still merge", async () => {
  const feed = createBikeFeed({
    fetchJson: async (url) => {
      if (url === FEED_URLS.donkeyLocations) return [null, KORENMARKT, 42]
      if (url === FEED_URLS.donkeyAvailability) return ["12022", { station_id: "12022", num_bikes_available: 3 }, null]
      if (url === FEED_URLS.bolt) return [null, { station_id: "b-1", name: "Veldstraat", lat: 51.0525, lon: 3.7233, num_bikes_available: 1 }]
      return [[], null]
    },
  })
  const answer = await feed.current()
  assert.deepEqual(
    answer.stations.map((s) => [stationKey(s), s.available]),
    [
      ["bikes:donkey:12022", 3],
      ["bikes:bolt:b-1", 1],
    ],
  )
  assert.deepEqual(answer.feeds, { donkey: "ok", bolt: "ok", "blue-bike": "ok" })
})

test("without Donkey Republic's availability its stations show 0 and its data is incomplete", async () => {
  const feed = createBikeFeed({
    fetchJson: async (url) => {
      if (url === FEED_URLS.donkeyAvailability) throw new Error("timeout")
      return url === FEED_URLS.donkeyLocations ? [KORENMARKT, STOPENBERGHE] : []
    },
  })
  const answer = await feed.current()
  assert.deepEqual(
    answer.stations.map((s) => s.available),
    [0, 0],
  )
  assert.equal(answer.feeds.donkey, "partial")
})

test("the feeds are read at most once a minute; callers in between share the answer", async () => {
  let clock = 0
  let requests = 0
  const feed = createBikeFeed({
    fetchJson: async () => {
      requests += 1
      return []
    },
    now: () => clock,
  })
  const datasets = 3 + FEED_URLS.blueBike.length
  const [a, b] = await Promise.all([feed.current(), feed.current()])
  assert.equal(a, b)
  assert.equal(requests, datasets)
  clock = 59_999
  await feed.current()
  assert.equal(requests, datasets)
  clock = 60_000
  await feed.current()
  assert.equal(requests, 2 * datasets)
})

test("GET /api/bikes is mounted with the other routes", async () => {
  const routes = await loadRoutes(new URL("../server/routes", import.meta.url).pathname)
  assert.ok(routes.some((r) => r.method === "GET" && r.path === "/api/bikes"))
})

test("the fixture has stations of two operators around the Belfry, and stays small", async () => {
  const answer = parseBikesAnswer(fixture())
  assert.equal(answer.stations.length, fixture().stations.length, "every fixture station is well formed")
  const operators = new Set(answer.stations.map((s) => s.operator))
  assert.ok(operators.size >= 2, `operators: ${[...operators].join(", ")}`)
  for (const s of answer.stations) {
    const { x, z } = toLocal(s)
    assert.ok(Math.hypot(x, z) <= FIXTURE_RADIUS_M, `${stationKey(s)} lies outside the fixture radius`)
  }
  assert.ok(statSync(FIXTURE_PATH).size < 300_000)
  // The city state reads the same stations; recorded mode has no snapshots of its own.
  assert.deepEqual(await bikeStations({ mode: "fixture", time: null }), answer.stations)
  assert.deepEqual(await bikeStations({ mode: "recorded", time: "2026-11-22T19:00:00Z" }), answer.stations)
})

test("bars are thin, grow with the bikes available, and stay below a garage column", () => {
  assert.equal(barHeight(0), EMPTY_BAR_M)
  assert.ok(EMPTY_BAR_M / BAR_WIDTH_M >= 5, "an empty station is still a post, not a block")
  for (let n = 0; n < 4; n++) assert.ok(barHeight(n + 1) > barHeight(n))
  assert.equal(barHeight(500), MAX_BAR_M)
  // The shortest garage column inside AREA (T5: 0.15 m per place) is about 22 m.
  assert.ok(MAX_BAR_M < 22)
  assert.equal(stationKey({ operator: "donkey", id: "35010" }), "bikes:donkey:35010")
})

test("an answer is checked: malformed stations dropped, unknown feeds missing", () => {
  const answer = parseBikesAnswer({
    time: "2026-11-22T19:00:00Z",
    feeds: { donkey: "ok", bolt: "broken" },
    stations: [
      { operator: "bolt", id: "b-1", name: "Veldstraat", lat: 51.0525, lon: 3.7233, available: 3 },
      { operator: "lime", id: "x", name: "Not an operator", lat: 51.05, lon: 3.72, available: 1 },
      { operator: "donkey", id: "", name: "No id", lat: 51.05, lon: 3.72, available: 1 },
      { operator: "donkey", id: "1", name: "No bikes", lat: 51.05, lon: 3.72 },
      null,
    ],
  })
  assert.deepEqual(
    answer.stations.map((s) => s.id),
    ["b-1"],
  )
  assert.deepEqual(answer.feeds, { donkey: "ok", bolt: "missing", "blue-bike": "missing" })
  assert.throws(() => parseBikesAnswer({ error: "boom" }), /no station list/)
})

test("the notice is quiet when all is well, and names what is missing or old", () => {
  const ok: BikesAnswer = { time: "2026-11-22T19:00:00Z", stations: [], feeds: { donkey: "ok", bolt: "ok", "blue-bike": "ok" } }
  const t = Date.parse(ok.time)
  assert.equal(bikesNotice(null, "fixture", t), null)
  assert.equal(bikesNotice(null, "live", t), "Shared bikes: no data yet, retrying")
  assert.equal(bikesNotice(ok, "fixture", t + 30 * 86_400_000), null, "a fixture's age is not news")
  assert.equal(bikesNotice(ok, "live", t + 4 * 60_000), null)
  assert.equal(bikesNotice(ok, "live", t + 10 * 60_000), "Shared bikes: data is 10 min old")
  assert.equal(bikesNotice(ok, "recorded", t), "Shared bikes: no recorded data, showing the sample")
  assert.equal(
    bikesNotice({ ...ok, feeds: { donkey: "partial", bolt: "ok", "blue-bike": "missing" } }, "live", t),
    "Shared bikes: Donkey Republic data incomplete, no Blue-bike data",
  )
})

test("the layer draws one bar per station, picks it by its id and highlights the selection", async () => {
  const realFetch = globalThis.fetch
  const requested: string[] = []
  globalThis.fetch = (async (url: string) => {
    requested.push(String(url))
    return new Response(readFileSync(FIXTURE_PATH, "utf8"), { headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  try {
    const layer = createBikesLayer()
    await layer.init({ mode: "fixture", time: null })
    assert.deepEqual(requested, ["/fixtures/bikes.json"])
    const stations = fixture().stations
    const bars = layer.group.getObjectByName("bike-bars") as InstancedMesh
    assert.equal(bars.count, stations.length)
    assert.equal(layer.notice?.(), null)

    // Korenmarkt has no other station within 15 m.
    const index = stations.findIndex((s) => s.id === "12022")
    const { x, z } = toLocal(stations[index]!)
    const down = new Raycaster(new Vector3(x + 2, 100, z), new Vector3(0, -1, 0))
    assert.equal(layer.pick?.(down), "bikes:donkey:12022")
    assert.equal(layer.pick?.(new Raycaster(new Vector3(5000, 100, 5000), new Vector3(0, -1, 0))), null)

    const color = new Color()
    layer.select?.("bikes:donkey:12022")
    bars.getColorAt(index, color)
    assert.equal(color.getHex(), 0xffffff)
    layer.select?.("garage:vrijdagmarkt")
    bars.getColorAt(index, color)
    assert.equal(color.getHex(), OPERATOR_COLORS.donkey)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("live: a failed first request is retried, and the notice clears once data arrives", async (t) => {
  const time = Date.parse(fixture().time)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: time })
  const realFetch = globalThis.fetch
  const requested: string[] = []
  globalThis.fetch = (async (url: string) => {
    requested.push(String(url))
    if (requested.length === 1) return new Response("unavailable", { status: 503 })
    return new Response(readFileSync(FIXTURE_PATH, "utf8"), { headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  // Lets the retry's fetch and JSON parsing settle; setImmediate is not mocked.
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  try {
    const layer = createBikesLayer()
    await layer.init({ mode: "live", time: null })
    assert.deepEqual(requested, ["/api/bikes"])
    assert.equal(layer.notice?.(), "Shared bikes: no data yet, retrying")
    assert.equal(layer.group.getObjectByName("bike-bars"), undefined)

    t.mock.timers.tick(10_000)
    await settle()
    assert.deepEqual(requested, ["/api/bikes", "/api/bikes"])
    assert.equal(layer.notice?.(), null)
    const bars = layer.group.getObjectByName("bike-bars") as InstancedMesh
    assert.equal(bars.count, fixture().stations.length)

    // After that it refreshes once a minute.
    t.mock.timers.tick(59_999)
    await settle()
    assert.equal(requested.length, 2)
    t.mock.timers.tick(1)
    await settle()
    assert.equal(requested.length, 3)
  } finally {
    globalThis.fetch = realFetch
  }
})

// test/fixtures/bikes.png is a real screenshot of checks/bikes.json's view, and
// test/recordings/ holds the Decisions API's answers for it, so this runs the whole
// check with no key and no network.
test("the recorded bikes screenshot passes its checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(
    process.execPath,
    ["scripts/check-visual.ts", "test/fixtures/bikes.png", "checks/bikes.json", "--replay"],
    { encoding: "utf8", env },
  )
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 4, run.stdout)
})
