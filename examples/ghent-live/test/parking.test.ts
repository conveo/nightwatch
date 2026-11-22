import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import type { ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Raycaster, Vector3 } from "three"
import type { GarageState } from "../server/city-state.ts"
import {
  CACHE_MS,
  coordinates,
  createParkingSource,
  garageStates,
  nearestSnapshot as serverNearest,
  parkingRoute,
  parseFeed,
  parseRecord,
  slugify,
  type FeedRecord,
  type ParkingSnapshot,
  type SnapshotFile,
} from "../server/routes/parking.ts"
import { addSnapshot, formatFixture, formatSnapshots, loadSnapshots, writeAtomic } from "../scripts/record-parking.ts"
import { toLocal } from "../src/geo.ts"
import {
  columnSpec,
  createParkingLayer,
  freeColor,
  freeShare,
  garageIdOf,
  METRES_PER_PLACE,
  nearestSnapshot as layerNearest,
  staleNotice,
} from "../src/layers/parking.ts"

// A record as the feed sends it (trimmed): the coordinates are in `location` and,
// again, inside the JSON string `locationanddimension`.
const VRIJDAGMARKT: FeedRecord = {
  name: "Vrijdagmarkt",
  lastupdate: "2026-11-22T19:40:15+01:00",
  totalcapacity: 602,
  availablecapacity: 252,
  isopennow: 1,
  temporaryclosed: 0,
  locationanddimension:
    '{"specificAccessInformation": ["inrit"], "level": "0", "roadName": "Vrijdagmarkt 1\\n9000 Gent", "coordinatesForDisplay": {"latitude": 51.05713405953412, "longitude": 3.726071777876147}}',
  location: { lon: 3.726071777876147, lat: 51.05713405953412 },
}

const garage = (over: Partial<GarageState> = {}): GarageState => ({
  slug: "vrijdagmarkt",
  name: "Vrijdagmarkt",
  lat: 51.05713405953412,
  lon: 3.726071777876147,
  capacity: 602,
  available: 252,
  updated: "2026-11-22T18:40:15.000Z",
  ...over,
})

test("slugs follow the contract: lower case ASCII, diacritics stripped, words joined by -", () => {
  assert.equal(slugify("Vrijdagmarkt"), "vrijdagmarkt")
  assert.equal(slugify("Sint-Michiels"), "sint-michiels")
  assert.equal(slugify("P+R The Loop"), "p-r-the-loop")
  assert.equal(slugify("The Loop - Parking D"), "the-loop-parking-d")
  assert.equal(slugify("  Dok noord "), "dok-noord")
  assert.equal(slugify("Kouter Café Élysée"), "kouter-cafe-elysee")
})

test("a record parses into the CityState garage shape", () => {
  assert.deepEqual(parseRecord(VRIJDAGMARKT), {
    slug: "vrijdagmarkt",
    name: "Vrijdagmarkt",
    lat: 51.05713405953412,
    lon: 3.726071777876147,
    capacity: 602,
    available: 252,
    updated: "2026-11-22T18:40:15.000Z",
  })
})

test("coordinates come from `location`, else from the JSON string in `locationanddimension`", () => {
  const onlyString = { ...VRIJDAGMARKT, location: undefined }
  assert.deepEqual(coordinates(onlyString), { lat: 51.05713405953412, lon: 3.726071777876147 })
  const onlyLocation = { ...VRIJDAGMARKT, locationanddimension: undefined }
  assert.deepEqual(coordinates(onlyLocation), { lat: 51.05713405953412, lon: 3.726071777876147 })
  // `location` wins when both are there and disagree.
  const both = { ...VRIJDAGMARKT, location: { lat: 51.05, lon: 3.72 } }
  assert.deepEqual(coordinates(both), { lat: 51.05, lon: 3.72 })
  // A malformed string, or one without coordinates, is no position at all.
  assert.equal(coordinates({ ...onlyString, locationanddimension: "{not json" }), null)
  assert.equal(coordinates({ ...onlyString, locationanddimension: '{"level": "0"}' }), null)
  assert.equal(parseRecord({ ...onlyString, locationanddimension: "{not json" }), null)
})

test("availability is clamped to the capacity, and a closed garage counts as full", () => {
  assert.equal(parseRecord({ ...VRIJDAGMARKT, availablecapacity: 603 })?.available, 602)
  assert.equal(parseRecord({ ...VRIJDAGMARKT, availablecapacity: -4 })?.available, 0)
  assert.equal(parseRecord({ ...VRIJDAGMARKT, temporaryclosed: 1 })?.available, 0)
  assert.equal(parseRecord({ ...VRIJDAGMARKT, isopennow: 0 })?.available, 0)
  assert.equal(parseRecord({ ...VRIJDAGMARKT, totalcapacity: "602", availablecapacity: "252" })?.available, 252)
})

test("records without a name, capacity or valid time are dropped", () => {
  assert.equal(parseRecord({ ...VRIJDAGMARKT, name: "" }), null)
  assert.equal(parseRecord({ ...VRIJDAGMARKT, totalcapacity: 0 }), null)
  assert.equal(parseRecord({ ...VRIJDAGMARKT, availablecapacity: null }), null)
  assert.equal(parseRecord({ ...VRIJDAGMARKT, lastupdate: "soon" }), null)
})

test("the feed parses into garages sorted by slug, with unique slugs", () => {
  const garages = parseFeed({
    total_count: 4,
    results: [
      { ...VRIJDAGMARKT, name: "Reep" },
      VRIJDAGMARKT,
      { ...VRIJDAGMARKT, name: "VRIJDAGMARKT" },
      { name: "broken" },
    ],
  })
  assert.deepEqual(
    garages.map((g) => g.slug),
    ["reep", "vrijdagmarkt", "vrijdagmarkt-2"],
  )
  assert.throws(() => parseFeed({ error: "quota" }), /no results array/)
})

test("the committed fixture is the feed's 15 garages, 5 of them in the drawn area", async () => {
  const fixture = JSON.parse(readFileSync("public/fixtures/parking.json", "utf8")) as ParkingSnapshot
  assert.equal(fixture.garages.length, 15)
  assert.ok(!Number.isNaN(Date.parse(fixture.time)))
  const layer = createParkingLayer({ fetch: fakeFetch({ "/fixtures/parking.json": fixture }) })
  await layer.init({ mode: "fixture", time: null })
  assert.deepEqual(layer.garages().map((g) => g.slug).sort(), ["ramen", "reep", "savaan", "sint-michiels", "vrijdagmarkt"])
  // Every garage is partly filled, so the visual check's columns are too.
  for (const g of layer.garages()) assert.ok(g.available > 0 && g.available < g.capacity, g.slug)
  assert.deepEqual(await garageStates({ mode: "fixture", time: null }), fixture.garages)
})

test("a column's height is the capacity, its filled part the occupied places, its colour the share free", () => {
  const spec = columnSpec({ capacity: 600, available: 150 })
  assert.equal(spec.height, 600 * METRES_PER_PLACE)
  assert.equal(spec.filled, 450 * METRES_PER_PLACE)
  assert.equal(spec.free, 0.25)
  assert.equal(freeShare({ capacity: 0, available: 10 }), 0)
  // Full is red, empty is green, and less free is never greener.
  const hue = (hex: number) => {
    const r = (hex >> 16) & 255
    const g = (hex >> 8) & 255
    return g / Math.max(1, r)
  }
  const red = freeColor(0)
  assert.ok(red >> 16 > 0xc0 && ((red >> 8) & 255) < 0x40, red.toString(16))
  assert.ok(hue(freeColor(1)) > 2)
  assert.ok(hue(freeColor(0.1)) < hue(freeColor(0.5)))
})

test("the layer and the server pick the same recorded snapshot: the nearest to t, else the latest", () => {
  const file: SnapshotFile = {
    snapshots: {
      "2026-11-22T18:00:00Z": [garage({ available: 100 })],
      "2026-11-22T18:30:00Z": [garage({ available: 200 })],
      "2026-11-22T19:00:00Z": [garage({ available: 300 })],
      "not a time": [garage({ available: 999 })],
    },
  }
  for (const nearest of [layerNearest, serverNearest]) {
    assert.equal(nearest(file, "2026-11-22T18:20:00Z")?.time, "2026-11-22T18:30:00Z")
    assert.equal(nearest(file, "2026-11-22T17:00:00Z")?.time, "2026-11-22T18:00:00Z")
    assert.equal(nearest(file, null)?.time, "2026-11-22T19:00:00Z")
    assert.equal(nearest(file, "2026-11-22T18:15:00Z")?.time, "2026-11-22T18:30:00Z") // a tie takes the later one
    assert.equal(nearest({ snapshots: {} }, null), null)
  }
})

test("the notice reports data more than 15 minutes old, and nothing otherwise", () => {
  const at = Date.parse("2026-11-22T18:40:15.000Z")
  const two = [garage(), garage({ slug: "reep", name: "Reep" })]
  assert.equal(staleNotice(two, "live", at + 15 * 60_000), null)
  assert.equal(staleNotice(two, "live", at + 22 * 60_000 + 5_000), "parking data is 22 minutes old")
  assert.equal(staleNotice(two, "live", at + 5 * 3_600_000), "parking data is 5 hours old")
  assert.equal(staleNotice(two, "live", at + 3 * 86_400_000), "parking data is 3 days old")
  // Fixture data is a sample, never stale; no garages, no notice.
  assert.equal(staleNotice(two, "fixture", at + 86_400_000), null)
  assert.equal(staleNotice([], "live", at + 86_400_000), null)
  // One garage that stopped updating is named.
  const mixed = [garage({ updated: "2026-11-22T18:00:00.000Z" }), garage({ slug: "reep", name: "Reep" })]
  assert.equal(staleNotice(mixed, "live", at + 60_000), "parking data for Vrijdagmarkt is more than 15 minutes old")
  // A recorded snapshot is measured against the time asked for, either way.
  assert.equal(staleNotice(two, "recorded", at - 40 * 60_000), "parking snapshot is 40 minutes from the requested time")
  assert.equal(staleNotice(two, "recorded", at + 10 * 60_000), null)
})

test("the layer's notice follows the clock in live mode", async () => {
  const fixture = JSON.parse(readFileSync("public/fixtures/parking.json", "utf8")) as ParkingSnapshot
  const newest = Math.max(...fixture.garages.map((g) => Date.parse(g.updated)))
  let clock = newest + 60_000
  const layer = createParkingLayer({ fetch: fakeFetch({ "/fixtures/parking.json": fixture }), now: () => clock })
  await layer.init({ mode: "fixture", time: null })
  assert.equal(layer.notice?.(), null)
  const live = createParkingLayer({ fetch: fakeFetch({ "/api/parking": fixture }), now: () => clock })
  await initLive(live)
  assert.equal(live.notice?.(), null)
  clock = newest + 60 * 60_000
  assert.equal(live.notice?.(), "parking data is 60 minutes old")
})

test("live mode keeps retrying after a failed first read, and draws once it answers", async () => {
  const fixture = JSON.parse(readFileSync("public/fixtures/parking.json", "utf8")) as ParkingSnapshot
  const newest = Math.max(...fixture.garages.map((g) => Date.parse(g.updated)))
  const files: Record<string, unknown> = {}
  const layer = createParkingLayer({ fetch: fakeFetch(files), now: () => newest + 60_000 })
  const refresh = await initLive(layer) // the first read fails, and init still resolves
  assert.equal(layer.garages().length, 0)
  assert.equal(layer.notice?.(), "parking data unavailable, retrying every minute (/api/parking answered 404)")
  files["/api/parking"] = fixture
  refresh()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(layer.garages().length, 5)
  assert.equal(layer.notice?.(), null)
  // A later failure keeps the data drawn; only its age can raise the notice.
  delete files["/api/parking"]
  refresh()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(layer.garages().length, 5)
  assert.equal(layer.notice?.(), null)
})

test("fixture and recorded mode fail the layer when their file is missing", async () => {
  await assert.rejects(createParkingLayer({ fetch: fakeFetch({}) }).init({ mode: "fixture", time: null }), /404/)
  await assert.rejects(createParkingLayer({ fetch: fakeFetch({}) }).init({ mode: "recorded", time: null }), /404/)
  const empty = createParkingLayer({ fetch: fakeFetch({ "/fixtures/parking/snapshots.json": { snapshots: {} } }) })
  await assert.rejects(empty.init({ mode: "recorded", time: null }), /no recorded parking snapshot/)
})

test("recorded mode draws the snapshot nearest to t", async () => {
  const file: SnapshotFile = {
    snapshots: {
      "2026-11-22T18:00:00Z": [garage({ available: 100, updated: "2026-11-22T17:59:00Z" })],
      "2026-11-22T19:00:00Z": [garage({ available: 300, updated: "2026-11-22T18:59:00Z" })],
    },
  }
  const layer = createParkingLayer({ fetch: fakeFetch({ "/fixtures/parking/snapshots.json": file }) })
  await layer.init({ mode: "recorded", time: "2026-11-22T18:10:00Z" })
  assert.equal(layer.garages()[0]?.available, 100)
  assert.equal(layer.notice?.(), null)
  const late = createParkingLayer({ fetch: fakeFetch({ "/fixtures/parking/snapshots.json": file }) })
  await late.init({ mode: "recorded", time: "2026-11-22T21:00:00Z" })
  assert.equal(late.garages()[0]?.available, 300)
  assert.equal(late.notice?.(), "parking snapshot is 2 hours from the requested time")
})

test("pick returns garage:<slug> for a ray through a column, and null beside it", async () => {
  const layer = createParkingLayer({ fetch: fakeFetch({ "/fixtures/parking.json": { time: "2026-11-22T18:47:48Z", garages: [garage()] } }) })
  await layer.init({ mode: "fixture", time: null })
  layer.group.updateMatrixWorld(true)
  const { x, z } = toLocal(garage())
  const down = new Vector3(0, -1, 0)
  assert.equal(layer.pick?.(new Raycaster(new Vector3(x, 500, z), down)), "garage:vrijdagmarkt")
  assert.equal(layer.pick?.(new Raycaster(new Vector3(x + 60, 500, z), down)), null)
  // Selecting is by the same id; any other selection clears it.
  assert.equal(garageIdOf("garage:vrijdagmarkt"), "vrijdagmarkt")
  assert.equal(garageIdOf("bldg:1362089"), null)
  assert.equal(garageIdOf(null), null)
  layer.select?.("garage:vrijdagmarkt")
  layer.setLight?.("night")
})

test("the live source reads the feed at most once a minute and keeps the last answer when it fails", async () => {
  let clock = Date.parse("2026-11-22T18:50:00Z")
  let calls = 0
  let fail = false
  const source = createParkingSource({
    now: () => clock,
    fetch: async () => {
      calls++
      if (fail) throw new Error("ECONNRESET")
      return { ok: true, status: 200, json: async () => ({ results: [VRIJDAGMARKT] }) }
    },
  })
  const [a, b] = await Promise.all([source.current(), source.current()])
  assert.equal(calls, 1)
  assert.equal(a, b)
  assert.equal(a.time, "2026-11-22T18:50:00.000Z")
  assert.equal(a.garages[0]?.slug, "vrijdagmarkt")
  clock += CACHE_MS - 1
  await source.current()
  assert.equal(calls, 1)
  clock += 2
  fail = true
  assert.equal(await source.current(), a) // the feed failed: the cached answer, unchanged
  assert.equal(calls, 2)
})

test("during an outage the feed is still read at most once a minute", async () => {
  let clock = Date.parse("2026-11-22T18:50:00Z")
  let calls = 0
  let fail = true
  const source = createParkingSource({
    now: () => clock,
    fetch: async () => {
      calls++
      if (fail) throw new Error("ECONNRESET")
      return { ok: true, status: 200, json: async () => ({ results: [VRIJDAGMARKT] }) }
    },
  })
  await assert.rejects(source.current(), /ECONNRESET/)
  clock += 10_000
  await assert.rejects(source.current(), /ECONNRESET/) // the same error, no new request
  assert.equal(calls, 1)
  clock += CACHE_MS
  fail = false
  const snapshot = await source.current()
  assert.equal(calls, 2)
  assert.equal(snapshot.garages.length, 1)
  // With a cached answer, a failing feed is asked once a minute, and the answer keeps its time.
  fail = true
  for (let i = 0; i < 5; i++) {
    clock += 30_000
    assert.equal(await source.current(), snapshot)
  }
  assert.equal(calls, 4) // the feed was asked at 18:52:10 and 18:53:10; the other reads came from the cache
  assert.equal(snapshot.time, "2026-11-22T18:51:10.000Z")
})

test("GET /api/parking answers the snapshot, or 502 when there is none", async () => {
  const ok = await call(parkingRoute({ current: async () => ({ time: "2026-11-22T18:50:00.000Z", garages: [garage()] }) }))
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.body), { time: "2026-11-22T18:50:00.000Z", garages: [garage()] })
  const down = await call(
    parkingRoute({
      current: async () => {
        throw new Error("parking feed answered 503")
      },
    }),
  )
  assert.equal(down.status, 502)
  assert.match(JSON.parse(down.body).error, /503/)
  const source = createParkingSource({ fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) })
  await assert.rejects(source.current(), /answered 503/)
})

test("recorded snapshots keep the newest ones and survive a round trip through the file format", () => {
  let file: SnapshotFile = { snapshots: {} }
  for (const t of ["2026-11-22T18:00:00Z", "2026-11-22T18:12:00Z", "2026-11-22T18:24:00Z"]) {
    file = addSnapshot(file, { time: t, garages: [garage()] }, 2)
  }
  assert.deepEqual(Object.keys(file.snapshots).sort(), ["2026-11-22T18:12:00Z", "2026-11-22T18:24:00Z"])
  assert.deepEqual(JSON.parse(formatSnapshots(file)), file)
  const snapshot = { time: "2026-11-22T18:47:48Z", garages: [garage()] }
  assert.deepEqual(JSON.parse(formatFixture(snapshot)), snapshot)
  // The committed recordings are in that format, small, and every one has garages.
  const committed = readFileSync("public/fixtures/parking/snapshots.json", "utf8")
  assert.ok(committed.length < 300_000)
  const parsed = JSON.parse(committed) as SnapshotFile
  assert.equal(formatSnapshots(parsed), committed)
  for (const garages of Object.values(parsed.snapshots)) assert.ok(garages.length > 0)
})

test("the recorder starts a missing file empty, and stops on one that does not parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghent-live-parking-"))
  const path = join(dir, "nested", "snapshots.json")
  assert.deepEqual(loadSnapshots(path), { snapshots: {} })
  const file = addSnapshot({ snapshots: {} }, { time: "2026-11-22T18:00:00Z", garages: [garage()] }, 48)
  writeAtomic(path, formatSnapshots(file))
  assert.deepEqual(loadSnapshots(path), file)
  writeFileSync(path, '{"snapshots": {"2026-11-22T18:00:00Z": [')
  assert.throws(() => loadSnapshots(path), SyntaxError)
  writeFileSync(path, '{"recordings": {}}')
  assert.throws(() => loadSnapshots(path), /no "snapshots" object/)
})

test("the recorded parking screenshot passes its checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(
    process.execPath,
    ["scripts/check-visual.ts", "test/fixtures/parking.png", "checks/parking.json", "--replay"],
    { encoding: "utf8", env },
  )
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 3, run.stdout)
})

// Helpers.

function fakeFetch(files: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    const body = files[url]
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body }
  }) as unknown as typeof fetch
}

// Live mode refreshes every minute. The test starts no timer: it gets the refresh
// back and runs it when it wants.
async function initLive(layer: ReturnType<typeof createParkingLayer>): Promise<() => void> {
  const realSetInterval = globalThis.setInterval
  let refresh: (() => void) | null = null
  globalThis.setInterval = ((fn: () => void) => {
    refresh = fn
    return 0
  }) as unknown as typeof setInterval
  try {
    await layer.init({ mode: "live", time: null })
  } finally {
    globalThis.setInterval = realSetInterval
  }
  assert.ok(refresh != null, "live mode schedules a refresh")
  return refresh
}

async function call(route: ReturnType<typeof parkingRoute>): Promise<{ status: number; body: string }> {
  const res = { statusCode: 0, body: "", setHeader() {}, end(chunk?: string) { this.body = chunk ?? "" } }
  await route.handle({} as never, res as unknown as ServerResponse, new URL("http://localhost/api/parking"))
  return { status: res.statusCode, body: res.body }
}
