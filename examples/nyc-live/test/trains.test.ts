import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Matrix4, Vector3, type InstancedMesh } from "three"
import GtfsRealtimeBindings from "gtfs-realtime-bindings"
import { trimFeed } from "../scripts/record-feeds.ts"
import {
  CACHE_MS,
  createMtaRoute,
  feedUrl,
  findSnapshot,
  FIXTURES_DIR,
  simplifyFeed,
  snapshotName,
  snapshotTime,
} from "../server/routes/mta.ts"
import { SUBWAY_DEPTH_M } from "../src/constants.ts"
import { toLatLon } from "../src/geo.ts"
import { project, toPath, type SubwayData, type SubwayShape } from "../src/layers/subway.ts"
import {
  busiestMoment,
  createTrainsLayer,
  fetchTrainFeed,
  FEEDS,
  feedsFor,
  matchShape,
  mergeTrip,
  positionAt,
  REFRESH_MS,
  shapeIdOf,
  toRun,
  trainColor,
  trainsSummary,
  type FeedTrip,
  type TrainFeed,
} from "../src/layers/trains.ts"

const { transit_realtime } = GtfsRealtimeBindings

const fixtureFile = (feed: string) => {
  const name = readdirSync(FIXTURES_DIR).find((n) => n.startsWith(`${feed}-`))
  assert.ok(name != null, `no ${feed} snapshot in public/fixtures/trains/`)
  return join(FIXTURES_DIR, name)
}
const subwayFixture = () => JSON.parse(readFileSync("public/fixtures/subway.json", "utf8")) as SubwayData

// [lat, lon] for a point `x` metres east and `z` metres south of the venue.
const at = (x: number, z: number): [number, number] => {
  const p = toLatLon({ x, z })
  return [p.lat, p.lon]
}

// A straight line 1 km east, with stations T01 (100 m), T02 (500 m) and T03 (900 m).
const line = (id = "N..N20R", route = "N"): SubwayShape => ({
  id,
  route,
  points: [at(0, 0), at(1000, 0)],
  stops: [
    { id: "T01", d: 100 },
    { id: "T02", d: 500 },
    { id: "T03", d: 900 },
  ],
})

const stop = (id: string, arrive: number, depart = arrive) => ({ id, arrive, depart })
const trip = (id: string, stops: FeedTrip["stops"], route = "N"): FeedTrip => ({ id, route, stops })

test("every committed snapshot stays small and is named by its feed's own time", () => {
  for (const name of readdirSync(FIXTURES_DIR)) {
    const path = join(FIXTURES_DIR, name)
    assert.ok(statSync(path).size < 300 * 1024, `${name} is over 300 KB`)
    const feed = name.slice(0, name.indexOf("-"))
    assert.ok(Object.hasOwn(FEEDS, feed), name)
    assert.equal(simplifyFeed(feed, "fixture", readFileSync(path)).timestamp, snapshotTime(name), name)
  }
})

test("a saved protobuf decodes into trips with their stops in order", () => {
  const feed = simplifyFeed("nqrw", "fixture", readFileSync(fixtureFile("nqrw")))
  assert.equal(feed.feed, "nqrw")
  assert.equal(feed.source, "fixture")
  assert.ok(feed.timestamp > Date.UTC(2026, 0, 1) / 1000)
  assert.ok(feed.trips.length >= 20, `${feed.trips.length} trips`)
  for (const t of feed.trips) {
    assert.ok(FEEDS.nqrw!.includes(t.route), `${t.id} is on route ${t.route}`)
    assert.match(t.id, /_[A-Z0-9]+\.\.[NS]/)
    assert.ok(t.stops.length > 0)
    for (const s of t.stops) {
      assert.match(s.id, /^[A-Z0-9]+[NS]$/)
      assert.ok(s.depart >= s.arrive)
    }
  }
})

test("the decoder keeps arrival-only and departure-only stops and drops cancelled trips", () => {
  const { FeedMessage, TripDescriptor } = transit_realtime
  const buffer = FeedMessage.encode(
    FeedMessage.create({
      header: { gtfsRealtimeVersion: "2.0", timestamp: 1_800_000_000 },
      entity: [
        {
          id: "1",
          tripUpdate: {
            trip: { tripId: "100000_R..N", routeId: "R" },
            stopTimeUpdate: [
              { stopId: "R23N", departure: { time: 1_800_000_030 } },
              { stopId: "R22N", arrival: { time: 1_800_000_090 } },
              { stopId: "R21N" },
            ],
          },
        },
        {
          id: "2",
          tripUpdate: {
            trip: { tripId: "100100_R..N", routeId: "R", scheduleRelationship: TripDescriptor.ScheduleRelationship.CANCELED },
            stopTimeUpdate: [{ stopId: "R22N", arrival: { time: 1_800_000_100 } }],
          },
        },
        { id: "3", vehicle: { trip: { tripId: "100000_R..N", routeId: "R" }, stopId: "R23N" } },
      ],
    }),
  ).finish()
  assert.deepEqual(simplifyFeed("nqrw", "live", buffer), {
    feed: "nqrw",
    source: "live",
    timestamp: 1_800_000_000,
    trips: [{ id: "100000_R..N", route: "R", stops: [stop("R23N", 1_800_000_030), stop("R22N", 1_800_000_090)] }],
  })
})

test("a trimmed fixture keeps only the trips that stop at the given stations, as a feed", () => {
  const raw = readFileSync(fixtureFile("nqrw"))
  const trimmed = trimFeed(raw, new Set(["R22"]))
  const before = simplifyFeed("nqrw", "fixture", raw)
  const after = simplifyFeed("nqrw", "fixture", trimmed)
  assert.equal(after.timestamp, before.timestamp)
  assert.ok(after.trips.length > 0 && after.trips.length < before.trips.length)
  for (const t of after.trips) assert.ok(t.stops.some((s) => s.id.startsWith("R22")), t.id)
  assert.deepEqual(
    after.trips.map((t) => t.id),
    before.trips.filter((t) => t.stops.some((s) => s.id.startsWith("R22"))).map((t) => t.id),
  )
})

test("snapshot names carry the feed time, and recorded mode picks the last one at or before t", () => {
  assert.equal(snapshotName("nqrw", 1792364530), "nqrw-20261018T230210Z.pb")
  assert.equal(snapshotTime("nqrw-20261018T230210Z.pb"), 1792364530)
  assert.equal(snapshotTime("notes.txt"), null)

  const a = mkdtempSync(join(tmpdir(), "nyc-live-trains-a-"))
  const b = mkdtempSync(join(tmpdir(), "nyc-live-trains-b-"))
  for (const [dir, time] of [
    [a, 1000],
    [a, 2000],
    [b, 3000],
  ] as const) {
    writeFileSync(join(dir, snapshotName("l", time)), "")
  }
  writeFileSync(join(b, snapshotName("nqrw", 2500)), "")
  assert.equal(findSnapshot([a, b], "l", 2999), join(a, snapshotName("l", 2000)))
  assert.equal(findSnapshot([a, b], "l", 3000), join(b, snapshotName("l", 3000)))
  assert.equal(findSnapshot([a, b], "l", 10), join(a, snapshotName("l", 1000)))
  assert.equal(findSnapshot([a, b, join(a, "missing")], "g", 2000), null)
})

// A stand-in for the ServerResponse sendJson writes to.
async function get(route: ReturnType<typeof createMtaRoute>, path: string) {
  const res = { statusCode: 0, body: "", setHeader() {}, end(body: string) { this.body = body } }
  await route.handle({} as IncomingMessage, res as unknown as ServerResponse, new URL(path, "http://127.0.0.1"))
  return { status: res.statusCode, body: JSON.parse(res.body) as TrainFeed & { error?: string } }
}

test("the route serves the fixture, a recording at t, and rejects unknown feeds and bad times", async () => {
  const recordings = mkdtempSync(join(tmpdir(), "nyc-live-recordings-"))
  const fixture = fixtureFile("l")
  const time = snapshotTime(fixture)!
  copyFileSync(fixture, join(recordings, snapshotName("l", time + 600)))
  const route = createMtaRoute({ recordings, fetch: (() => Promise.reject(new Error("no network in tests"))) as typeof fetch })

  const fx = await get(route, "/api/mta/l?fixture")
  assert.equal(fx.status, 200)
  assert.equal(fx.body.source, "fixture")
  assert.equal(fx.body.timestamp, time)
  assert.ok(fx.body.trips.length > 0)

  // Before the recording, the committed snapshot is the last one; after it, the recording.
  const iso = (s: number) => new Date(s * 1000).toISOString()
  const early = await get(route, `/api/mta/l?t=${iso(time + 300)}`)
  assert.equal(early.body.source, "recorded")
  assert.equal(early.body.trips.length, fx.body.trips.length)
  const late = await get(route, `/api/mta/l?t=${iso(time + 900)}`)
  assert.equal(late.status, 200)

  assert.equal((await get(route, "/api/mta/x")).status, 404)
  assert.equal((await get(route, "/api/mta/l?t=yesterday")).status, 400)
  assert.equal((await get(route, `/api/mta/si?t=${iso(time)}`)).status, 404)
  // Live with no network and nothing fetched before: a gateway error, not a crash.
  assert.equal((await get(route, "/api/mta/l")).status, 502)
})

test("live feeds are fetched from the MTA at most every 15 s, and the last good one covers a failure", async () => {
  const body = readFileSync(fixtureFile("l"))
  let clock = 1_000_000
  const urls: string[] = []
  let fail = false
  const route = createMtaRoute({
    now: () => clock,
    fetch: (async (url: string) => {
      urls.push(url)
      return fail ? new Response("busy", { status: 503 }) : new Response(new Uint8Array(body))
    }) as typeof fetch,
  })
  const first = await get(route, "/api/mta/l")
  assert.equal(first.status, 200)
  assert.equal(first.body.source, "live")
  clock += CACHE_MS - 1
  await get(route, "/api/mta/l")
  assert.equal(urls.length, 1)
  clock += 2
  fail = true
  const stale = await get(route, "/api/mta/l")
  assert.equal(urls.length, 2)
  assert.equal(stale.status, 200)
  assert.equal(stale.body.timestamp, first.body.timestamp)
  // A failure is not cached.
  await get(route, "/api/mta/l")
  assert.equal(urls.length, 3)
  assert.deepEqual(urls.slice(0, 1), [feedUrl("l")])
  assert.equal(feedUrl("l"), "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l")
  assert.equal(feedUrl("1234567"), "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs")
})

test("the feeds for a set of routes", () => {
  assert.deepEqual(feedsFor(["N", "6X", "F", "L"]), ["1234567", "bdfm", "l", "nqrw"])
  assert.deepEqual(feedsFor(["X"]), [])
  assert.equal(shapeIdOf("105600_N..S36R"), "N..S36R")
})

test("a trip finds its shape by id, then by route, direction and stations, then by the tracks it uses", () => {
  const local = line("R..N93R", "R")
  const express: SubwayShape = { ...line("R..N99R", "R"), stops: [line().stops[0]!, line().stops[2]!] }
  const south: SubwayShape = { ...line("R..S93R", "R"), stops: [...line().stops].reverse() }
  const other: SubwayShape = { ...line("F..N69R", "F"), stops: [{ id: "D21", d: 200 }, { id: "D20", d: 700 }] }
  const all = [local, express, south, other]
  const shapes = new Map(all.map((s) => [s.id, s]))
  const byRoute = new Map<string, SubwayShape[]>()
  for (const s of all) byRoute.set(s.route, [...(byRoute.get(s.route) ?? []), s])

  assert.equal(matchShape(trip("1_R..N99R", [stop("Z9N", 1)], "R"), shapes, byRoute), express)
  // Not in the static feed: the local, which stops at B, beats the express, which skips it.
  assert.equal(matchShape(trip("1_R..N05X", [stop("T01N", 1), stop("T02N", 2), stop("T03N", 3)], "R"), shapes, byRoute), local)
  assert.equal(matchShape(trip("1_R..N05X", [stop("T01N", 1), stop("T03N", 3)], "R"), shapes, byRoute), express)
  assert.equal(matchShape(trip("1_R..S05X", [stop("T03S", 1), stop("T02S", 2)], "R"), shapes, byRoute), south)
  // A C train running on the F's tracks.
  assert.equal(matchShape(trip("1_C..N04X", [stop("D21N", 1), stop("D20N", 2)], "C"), shapes, byRoute), other)
  assert.equal(matchShape(trip("1_C..N04X", [stop("D21N", 1)], "C"), shapes, byRoute), null)
  assert.equal(matchShape(trip("1_R..N05X", [stop("Q1N", 1)], "R"), shapes, byRoute), null)
})

test("a train is placed between two stops by their times", () => {
  // It goes on to X9, beyond the end of the drawn line.
  const stops = [stop("T01N", 990, 1000), stop("T02N", 1060), stop("T03N", 1120), stop("X9N", 1300)]
  const run = toRun(trip("1_N..N20R", stops), line())!
  assert.equal(run.stops.length, 3)
  assert.equal(run.ends, false)
  assert.equal(positionAt(run, 995), 100, "dwelling at A")
  assert.equal(positionAt(run, 1030), 300, "half way from A to B")
  assert.equal(positionAt(run, 1060), 500, "at B")
  assert.equal(positionAt(run, 1090), 700, "half way from B to C")
  // Its own pace (400 m a minute) before A and after C, until it leaves the line.
  assert.ok(Math.abs(run.speed - 400 / 60) < 1e-9)
  assert.ok(Math.abs(positionAt(run, 990 - 6)! - 60) < 1e-9)
  assert.ok(Math.abs(positionAt(run, 1120 + 6)! - 940) < 1e-9)
  assert.equal(positionAt(run, 990 - 30), null, "not on the line yet")
  assert.equal(positionAt(run, 1120 + 30), null, "off the end of the line")
})

test("a train that left the station before its first known stop waits there, not behind it", () => {
  // B and C are ahead; A, on the shape before B, is already behind it.
  const run = toRun(trip("1_N..N20R", [stop("T02N", 1300), stop("T03N", 1360)]), line())!
  assert.equal(run.before, 100)
  assert.equal(positionAt(run, 1290), 500 - 10 * (400 / 60))
  assert.equal(positionAt(run, 1000), 100)
  // Still to call at a station off the line first: it has not reached the line yet.
  const away = toRun(trip("1_N..N20R", [stop("X1N", 1200), stop("T02N", 1300)]), line())!
  assert.equal(positionAt(away, 1000), null)
  // Due at its first stop in ten minutes: a trip that has not started, not a train waiting at T01.
  assert.equal(positionAt(run, 1300 - 600), null)
})

test("a train stays at a terminal for a minute, and a trip with no stop on the shape is not placed", () => {
  const run = toRun(trip("1_N..N20R", [stop("T02N", 1000), stop("T03N", 1060)]), line())!
  assert.equal(run.ends, true)
  assert.equal(positionAt(run, 1100), 900)
  assert.equal(positionAt(run, 1121), null)
  assert.equal(toRun(trip("1_N..N20R", [stop("X1N", 1000)]), line()), null)
})

test("a newer feed's trip keeps the stops an older one knew it had passed", () => {
  const older = trip("1_N..N20R", [stop("T01N", 1000), stop("T02N", 1060), stop("T03N", 1120)])
  const newer = trip("1_N..N20R", [stop("T02N", 1065), stop("T03N", 1125)])
  assert.deepEqual(mergeTrip(older, newer).stops, [stop("T01N", 1000), stop("T02N", 1065), stop("T03N", 1125)])
  assert.equal(mergeTrip(undefined, newer), newer)
})

test("the HUD says positions may not be real time once the data is over a minute old", () => {
  const now = Date.UTC(2026, 9, 18, 23, 10, 0)
  assert.equal(trainsSummary(12, now / 1000 - 30, now), "12 trains")
  assert.equal(trainsSummary(1, now / 1000 - 60, now), "1 train")
  assert.equal(
    trainsSummary(12, now / 1000 - 61, now),
    "12 trains · MTA data from Oct 18, 7:08 PM ET: positions may not be real time",
  )
  assert.equal(trainsSummary(0, null, now, ["ace"]), "0 trains · no train data for ace")
})

test("a train is its line's colour, a little lighter", () => {
  const hsl = { h: 0, s: 0, l: 0 }
  trainColor("#FCCC0A").getHSL(hsl, "srgb")
  assert.ok(Math.abs(hsl.h - 48 / 360) < 0.01 && hsl.l > 0.55, JSON.stringify(hsl))
})

test("the browser asks the app's own server for each feed, never the MTA", async () => {
  const urls: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    urls.push(url)
    return Response.json({ feed: "l", source: "live", timestamp: 1, trips: [] })
  }) as typeof fetch
  try {
    await fetchTrainFeed("l", "fixture", null)
    await fetchTrainFeed("l", "recorded", "2026-10-18T23:02:10Z")
    await fetchTrainFeed("l", "recorded", null)
    await fetchTrainFeed("l", "live", null)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(urls[0], "/api/mta/l?fixture")
  assert.equal(urls[1], "/api/mta/l?t=2026-10-18T23%3A02%3A10Z")
  assert.match(urls[2]!, /^\/api\/mta\/l\?t=\d{4}-\d\d-\d\dT/)
  assert.equal(urls[3], "/api/mta/l")
})

async function layerFrom(subway: SubwayData, mode: "fixture" | "recorded" | "live", time: string | null, now = Date.now) {
  const requests: Array<{ feed: string; t: string | null }> = []
  const layer = createTrainsLayer({
    loadSubway: async () => subway,
    loadFeed: async (feed, _mode, t) => {
      requests.push({ feed, t })
      return simplifyFeed(feed, mode === "live" ? "live" : "recorded", readFileSync(fixtureFile(feed)))
    },
    now,
  })
  await layer.init({ mode, time })
  const mesh = layer.group.getObjectByName("train-blocks") as InstancedMesh
  return { layer, mesh, requests }
}

test("fixture and recorded mode draw trains on their lines and say they may not be real time", async () => {
  const subway = subwayFixture()
  const saved = snapshotTime(fixtureFile("nqrw"))!
  const { layer, mesh, requests } = await layerFrom(subway, "fixture", null)
  assert.deepEqual(requests.map((r) => r.feed).sort(), ["1234567", "bdfm", "nqrw"])
  assert.ok(mesh.count >= 1, `${mesh.count} trains`)
  assert.match(layer.summary!()!, new RegExp(`^${mesh.count} trains? · MTA data from .*: positions may not be real time$`))
  const paths = subway.shapes.map((s) => toPath(s.points))
  const m = new Matrix4()
  const p = new Vector3()
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m)
    p.setFromMatrixPosition(m)
    assert.equal(p.y, SUBWAY_DEPTH_M + 1)
    const offset = Math.min(...paths.map((path) => project(path, { x: p.x, z: p.z }).offset))
    assert.ok(offset < 0.5, `train ${i} is ${offset.toFixed(1)} m off the nearest line`)
  }

  const recorded = await layerFrom(subway, "recorded", new Date(saved * 1000).toISOString())
  assert.equal(recorded.requests[0]!.t, new Date(saved * 1000).toISOString())
  assert.match(recorded.layer.summary!()!, /positions may not be real time/)
})

test("the fixture's clock starts at its busiest moment", () => {
  const runs = [
    toRun(trip("1_N..N20R", [stop("T01N", 1000), stop("T02N", 1060)]), line())!,
    toRun(trip("2_N..N20R", [stop("T01N", 1030), stop("T02N", 1090)]), line())!,
  ]
  // The first runs in from 985 and the second from 1015 (at 6.7 m/s to A, 100 m in);
  // the scan, every 15 s from 900, first sees both at 1020.
  assert.equal(busiestMoment(runs, 900, 600, 15), 1020)
})

test("live mode asks for the feeds again every 30 s and is current when the feed is", async () => {
  const subway = subwayFixture()
  const saved = snapshotTime(fixtureFile("nqrw"))!
  const { layer, requests } = await layerFrom(subway, "live", null, () => saved * 1000 + 20_000)
  const n = requests.length
  assert.ok(!/real time/.test(layer.summary!()!), layer.summary!()!)
  layer.update!(performance.now(), 16)
  assert.equal(requests.length, n)
  layer.update!(performance.now() + REFRESH_MS + 1, 16)
  assert.equal(requests.length, 2 * n)
  assert.ok(requests.every((r) => r.t == null))
})

// test/fixtures/trains.png is a real screenshot of recorded mode, and test/recordings/
// holds the Decisions API's answers for it, so this runs the visual check with no key.
test("the recorded trains screenshot passes its checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(process.execPath, ["scripts/check-visual.ts", "test/fixtures/trains.png", "checks/trains.json", "--replay"], {
    encoding: "utf8",
    env,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 2, run.stdout)
})
