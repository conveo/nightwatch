import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { routesMiddleware } from "../server/api.ts"
import {
  CACHE_MS,
  citibikeRoute,
  createCitibikeSource,
  GBFS_FEEDS,
  mergeGbfs,
  type CitibikeDock,
  type CitibikeSnapshot,
  type GbfsStationInformation,
  type GbfsStationStatus,
} from "../server/routes/citibike.ts"
import { barSegments, COLOURS, METRES_PER_BIKE, STUB_HEIGHT_M, summarize } from "../src/layers/citibike.ts"
import { FIXTURE_RADIUS_M } from "../src/constants.ts"
import { toLocal } from "../src/geo.ts"

// Two docks by the venue, one in Brooklyn (outside AREA), one not installed, one
// with no status, and a status for a station that has no information.
const information: GbfsStationInformation = {
  last_updated: 1_792_362_199,
  data: {
    stations: [
      { station_id: "b", name: "Mercer St & Spring St", lat: 40.7236, lon: -74.0, capacity: 67 },
      { station_id: "a", name: "Greene St & Prince St", lat: 40.7251, lon: -73.9993, capacity: 45 },
      { station_id: "bk", name: "Morris Ave & E 142 St", lat: 40.8145, lon: -73.925, capacity: 23 },
      { station_id: "gone", name: "Removed", lat: 40.725, lon: -73.997, capacity: 20 },
      { station_id: "quiet", name: "No status", lat: 40.725, lon: -73.997, capacity: 20 },
    ],
  },
}
const status: GbfsStationStatus = {
  last_updated: 1_792_362_199,
  data: {
    stations: [
      { station_id: "a", num_bikes_available: 41, num_ebikes_available: 31, num_docks_available: 0, is_installed: 1, is_renting: 1 },
      { station_id: "b", num_bikes_available: 66, num_ebikes_available: 55, num_docks_available: 0, is_installed: true, is_renting: false },
      { station_id: "bk", num_bikes_available: 3, num_ebikes_available: 0, num_docks_available: 20, is_installed: 1, is_renting: 1 },
      { station_id: "gone", num_bikes_available: 0, num_docks_available: 0, is_installed: 0, is_renting: 0 },
      { station_id: "orphan", num_bikes_available: 9, num_docks_available: 1, is_installed: 1, is_renting: 1 },
    ],
  },
}

test("mergeGbfs joins the feeds on station_id and keeps installed docks inside AREA", () => {
  const snapshot = mergeGbfs(information, status)
  assert.equal(snapshot.updated, "2026-10-18T22:23:19.000Z")
  assert.deepEqual(snapshot.docks, [
    { id: "a", name: "Greene St & Prince St", lat: 40.7251, lon: -73.9993, capacity: 45, bikes: 41, ebikes: 31, docks: 0, renting: true },
    { id: "b", name: "Mercer St & Spring St", lat: 40.7236, lon: -74.0, capacity: 67, bikes: 66, ebikes: 55, docks: 0, renting: false },
  ])
})

test("mergeGbfs counts e-bikes inside bikes and tolerates missing or odd counts", () => {
  const info: GbfsStationInformation = {
    last_updated: 0,
    data: { stations: [{ station_id: "x", name: "X", lat: 40.72, lon: -74.0 }] },
  }
  const odd: GbfsStationStatus = {
    last_updated: 0,
    // More e-bikes than bikes, a negative count, no capacity and no dock count.
    data: { stations: [{ station_id: "x", num_bikes_available: 4, num_ebikes_available: 7, is_installed: 1, is_renting: 1 }] },
  }
  assert.deepEqual(mergeGbfs(info, odd).docks[0], {
    id: "x", name: "X", lat: 40.72, lon: -74.0, capacity: 4, bikes: 4, ebikes: 4, docks: 0, renting: true,
  })
  odd.data.stations[0]!.num_bikes_available = -2
  assert.equal(mergeGbfs(info, odd).docks[0]!.bikes, 0)
  assert.equal(mergeGbfs(info, odd).docks[0]!.ebikes, 0)
  // A custom filter replaces AREA.
  assert.equal(mergeGbfs(info, odd, () => false).docks.length, 0)
})

function dock(over: Partial<CitibikeDock>): CitibikeDock {
  return { id: "d", name: "D", lat: 40.72, lon: -74.0, capacity: 40, bikes: 0, ebikes: 0, docks: 40, renting: true, ...over }
}

test("a bar is classic bikes with e-bikes stacked on top, and an empty dock is a grey stub", () => {
  const [classic, ebike] = barSegments(dock({ bikes: 30, ebikes: 12 }))
  assert.deepEqual(classic, { bottom: 0, height: 18 * METRES_PER_BIKE, colour: COLOURS.classic })
  assert.deepEqual(ebike, { bottom: 18 * METRES_PER_BIKE, height: 12 * METRES_PER_BIKE, colour: COLOURS.ebike })
  for (const empty of [dock({ bikes: 0 }), dock({ bikes: 9, ebikes: 2, renting: false })]) {
    const [stub, none] = barSegments(empty)
    assert.deepEqual(stub, { bottom: 0, height: STUB_HEIGHT_M, colour: COLOURS.empty })
    assert.equal(none.height, 0)
  }
  const docks = [dock({ bikes: 1200, ebikes: 300 }), dock({ bikes: 5, ebikes: 1 }), dock({ bikes: 9, ebikes: 4, renting: false })]
  // 22:23 UTC is 18:23 in New York in October (EDT).
  assert.equal(summarize({ updated: "2026-10-18T22:23:19.000Z", docks }), "3 Citi Bike docks · 1,205 bikes (301 e-bikes) at 18:23")
  assert.equal(summarize({ updated: "", docks }), "3 Citi Bike docks · 1,205 bikes (301 e-bikes)")
})

function fakeFeeds() {
  const calls: string[] = []
  let fail = false
  const fetchJson = async <T>(url: string): Promise<T> => {
    calls.push(url)
    if (fail) throw new Error("feed down")
    return (url === GBFS_FEEDS.information ? information : status) as T
  }
  return { calls, fetchJson, setFail: (f: boolean) => (fail = f) }
}

test("the source reads both feeds at most once per 30 s, and shares a request in flight", async () => {
  const feeds = fakeFeeds()
  let now = 1_000
  const source = createCitibikeSource(feeds.fetchJson, () => now)
  const [first, second] = await Promise.all([source.get(), source.get()])
  assert.equal(first, second)
  assert.equal(feeds.calls.length, 2)
  now += CACHE_MS - 1
  await source.get()
  assert.equal(feeds.calls.length, 2)
  now += 1
  await source.get()
  assert.deepEqual(feeds.calls.slice(2).sort(), [GBFS_FEEDS.information, GBFS_FEEDS.status].sort())
})

test("a failed refresh serves the last good snapshot and is not cached", async () => {
  const feeds = fakeFeeds()
  let now = 0
  const source = createCitibikeSource(feeds.fetchJson, () => now)
  feeds.setFail(true)
  await assert.rejects(source.get(), /feed down/)
  feeds.setFail(false)
  const good = await source.get()
  now += CACHE_MS
  feeds.setFail(true)
  assert.equal(await source.get(), good)
  // The failure was not cached: the next call goes to the feeds again.
  const before = feeds.calls.length
  await source.get()
  assert.equal(feeds.calls.length, before + 2)
})

async function serveRoute(fetchJson: <T>(url: string) => Promise<T>) {
  const middleware = routesMiddleware([citibikeRoute(createCitibikeSource(fetchJson))])
  const server = createServer((req, res) => middleware(req, res, () => res.end()))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return { base, close }
}

test("GET /api/citibike answers the merged docks, or 502 while the feed is down", async () => {
  const up = await serveRoute(fakeFeeds().fetchJson)
  try {
    const res = await fetch(`${up.base}/api/citibike`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as CitibikeSnapshot
    assert.deepEqual(body.docks.map((d) => d.id), ["a", "b"])
  } finally {
    await up.close()
  }
  const broken = fakeFeeds()
  broken.setFail(true)
  const down = await serveRoute(broken.fetchJson)
  try {
    const res = await fetch(`${down.base}/api/citibike`)
    assert.equal(res.status, 502)
    assert.match(((await res.json()) as { error: string }).error, /feed down/)
  } finally {
    await down.close()
  }
})

test("the fixture is small, near the venue, and has bars of different heights", () => {
  const path = new URL("../public/fixtures/citibike.json", import.meta.url)
  assert.ok(statSync(path).size < 300 * 1024)
  const fixture = JSON.parse(readFileSync(path, "utf8")) as CitibikeSnapshot
  assert.ok(!Number.isNaN(Date.parse(fixture.updated)))
  assert.ok(fixture.docks.length >= 5)
  for (const d of fixture.docks) {
    const { x, z } = toLocal(d)
    assert.ok(Math.hypot(x, z) <= FIXTURE_RADIUS_M, d.name)
    assert.ok(d.ebikes <= d.bikes, d.name)
  }
  assert.ok(new Set(fixture.docks.map((d) => d.bikes)).size >= 5)
  assert.ok(fixture.docks.some((d) => d.ebikes > 0 && d.ebikes < d.bikes))
})

// test/fixtures/citibike.png is a real screenshot of the fixture view, and
// test/recordings/ holds the Decisions API's real answers for it.
test("the recorded Citi Bike screenshot passes its checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(
    process.execPath,
    ["scripts/check-visual.ts", "test/fixtures/citibike.png", "checks/citibike.json", "--replay"],
    { encoding: "utf8", env },
  )
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 2, run.stdout)
})
