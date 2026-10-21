import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock, test } from "node:test"
import { Mesh, PerspectiveCamera, Vector3, type MeshBasicMaterial } from "three"
import { routesMiddleware, type Route } from "../server/api.ts"
import { fixtureProvider, type CityStateProvider } from "../server/city-state.ts"
import { createAskRoutes } from "../server/routes/ask.ts"
import type { CitibikeSnapshot } from "../server/routes/citibike.ts"
import {
  cityRoute,
  createLiveProvider,
  createRecordedProvider,
  docksFrom,
  LINES,
  lineServices,
} from "../server/routes/city.ts"
import { createMtaSource, FIXTURES_DIR, type MtaSource } from "../server/routes/mta.ts"
import type { AskOptions } from "../src/ask/types.ts"
import { xrayFade, type SubwayData } from "../src/layers/subway.ts"
import { createVenueLayer } from "../src/layers/venue.ts"
import { createTrainsLayer, playbackTime, type FeedTrip, type TrainFeed } from "../src/layers/trains.ts"
import { followCamera, PRESETS } from "../src/ui/camera.ts"
import { VENUE_MARKER, venueMarkerTop } from "../src/ui/labels.ts"
import { statusLine } from "../src/ui/layers.ts"
import { parseViewState, serializeViewState } from "../src/view-state.ts"

// How the tickets' pieces work together (T8 in plan/PLAN.md): the city state "ask the
// city" answers from in recorded and live mode, the URL following a gliding camera,
// the see-through subway's fade, the morning review plan, and the stage screenshot.

const AT = 1_792_364_537 // 2026-10-18T23:02:17Z

// `count` trains of `route`, `everyMin` apart, each stopping at `platform`.
function trips(route: string, platform: string, count: number, everyMin: number, from = AT + 60): FeedTrip[] {
  return Array.from({ length: count }, (_, i) => {
    const arrive = from + i * everyMin * 60
    return { id: `${route}-${i}`, route, stops: [{ id: platform, arrive, depart: arrive + 30 }] }
  })
}

function feed(id: string, list: FeedTrip[], timestamp = AT): TrainFeed {
  return { feed: id, source: "recorded", timestamp, trips: list }
}

test("a line's service comes from the trains in its feed", () => {
  const services = lineServices(
    [
      feed("nqrw", [...trips("R", "R22N", 7, 8), ...trips("N", "R20S", 2, 25)]),
      feed("1234567", [...trips("6", "637S", 4, 5), ...trips("6X", "637S", 4, 5, AT + 150)]),
    ],
    AT,
  )
  const byId = new Map(services.map((s) => [s.id, s]))
  assert.deepEqual(byId.get("R"), { id: "R", color: "#FCCC0A", status: "normal", headwayMin: 8, note: null })
  // Fewer than every 15 minutes is a reduced service.
  assert.equal(byId.get("N")?.status, "reduced")
  assert.equal(byId.get("N")?.headwayMin, 25)
  // A diamond express is its line's train: 6 and 6X together come every 2.5 min.
  assert.equal(byId.get("6")?.status, "normal")
  assert.ok(byId.get("6")!.headwayMin! <= 3)
  // In a feed that arrived but carries no trip of it, a line does not run.
  assert.equal(byId.get("W")?.status, "suspended")
  assert.equal(byId.get("W")?.headwayMin, null)
  // A single train in the hour is a train an hour, not none.
  assert.deepEqual(lineServices([feed("l", trips("L", "L03N", 1, 5))], AT)[0], {
    id: "L",
    color: "#A7A9AC",
    status: "reduced",
    headwayMin: 60,
    note: "only one train due in the next hour",
  })
  // The lines of a feed that did not arrive are left out, not guessed.
  assert.ok(!byId.has("F") && !byId.has("A"))
  // Arrivals already past, or more than an hour off, do not count: no train is due.
  for (const from of [AT - 3600, AT + 3700]) {
    const [l] = lineServices([feed("l", trips("L", "L03N", 6, 5, from))], AT)
    assert.deepEqual([l?.status, l?.headwayMin], ["suspended", null])
  }
  // Every line follows LINES' order.
  assert.deepEqual(
    services.map((s) => s.id),
    LINES.filter((id) => byId.has(id)),
  )
})

test("docks count classic bikes and e-bikes apart, and nothing to rent where renting stopped", () => {
  const snapshot: CitibikeSnapshot = {
    updated: "2026-10-18T23:00:00.000Z",
    docks: [
      { id: "a", name: "A", lat: 40.72, lon: -74, capacity: 20, bikes: 9, ebikes: 4, docks: 11, renting: true },
      { id: "b", name: "B", lat: 40.73, lon: -74, capacity: 10, bikes: 3, ebikes: 1, docks: 7, renting: false },
    ],
  }
  assert.deepEqual(docksFrom(snapshot), [
    { id: "a", name: "A", lat: 40.72, lon: -74, bikes: 5, ebikes: 4, freeDocks: 11 },
    { id: "b", name: "B", lat: 40.73, lon: -74, bikes: 0, ebikes: 0, freeDocks: 7 },
  ])
})

const FIXTURE_DOCKS = JSON.parse(readFileSync("public/fixtures/citibike.json", "utf8")) as CitibikeSnapshot

test("recorded mode answers from the saved feed at the view's time", async () => {
  const empty = mkdtempSync(join(tmpdir(), "nyc-live-no-recordings-"))
  const provider = createRecordedProvider({
    mta: createMtaSource({ recordings: empty, fixtures: FIXTURES_DIR }),
    recordedDocks: () => FIXTURE_DOCKS,
    now: () => Date.parse("2026-10-19T12:00:00Z"),
  })
  const state = await provider.get("2026-10-18T23:02:17Z")
  assert.equal(state.source, "recorded")
  assert.equal(state.time, "2026-10-18T23:02:17Z")
  const r = state.lines.find((l) => l.id === "R")
  assert.equal(r?.status, "normal")
  assert.ok(r!.headwayMin! >= 2 && r!.headwayMin! <= 15, `R every ${r?.headwayMin} min`)
  // The committed sample has no W trains: Sunday evening.
  assert.equal(state.lines.find((l) => l.id === "W")?.status, "suspended")
  assert.equal(state.docks.length, FIXTURE_DOCKS.docks.length)
  // The same time is the same state.
  assert.equal(await provider.get("2026-10-18T23:02:17Z"), state)
  // Without a time, the latest recording from its own start, as the trains layer plays it.
  assert.equal((await provider.get(null)).time, "2026-10-18T23:02:17Z")
})

test("live mode answers from the feeds now, and at once from the last state while a new one loads", async () => {
  let clock = AT * 1000
  let loads = 0
  let failing = new Set<string>()
  // A feed down behind the shared source's cache: it serves its last good data, from then.
  const frozen = new Map<string, number>()
  const mta: MtaSource = {
    async live(id) {
      loads++
      if (failing.has(id)) throw new Error(`${id} down`)
      const at = frozen.get(id) ?? clock / 1000
      return feed(id, id === "nqrw" ? trips("R", "R22N", 7, 8, at + 60) : [], at)
    },
    recorded: () => null,
  }
  let bikesDown = false
  let bikesUpdated = new Date(AT * 1000).toISOString()
  const citibike = {
    get: async () => {
      if (bikesDown) throw new Error("GBFS down")
      return { ...FIXTURE_DOCKS, updated: bikesUpdated }
    },
  }
  const warn = mock.method(console, "warn", () => {})
  try {
    const provider = createLiveProvider({ mta, citibike, now: () => clock })
    const first = await provider.get(null)
    assert.equal(first.source, "live")
    assert.equal(first.time, "2026-10-18T23:02:17Z")
    assert.equal(first.lines.find((l) => l.id === "R")?.headwayMin, 8)
    assert.equal(first.docks.length, FIXTURE_DOCKS.docks.length)

    // Within 15 s the same state answers, without asking the feeds again.
    const asked = loads
    clock += 10_000
    assert.equal(await provider.get(null), first)
    assert.equal(loads, asked)

    // After 15 s the last state still answers at once, while a newer one loads.
    failing = new Set(["bdfm"])
    bikesDown = true
    clock += 10_000
    assert.equal(await provider.get(null), first)
    await new Promise((resolve) => setImmediate(resolve))
    const next = await provider.get(null)
    assert.notEqual(next, first)
    // A feed that fails leaves its lines out; docks that fail leave none; the rest answers.
    assert.ok(!next.lines.some((l) => ["B", "D", "F", "M"].includes(l.id)))
    assert.ok(next.lines.some((l) => l.id === "R"))
    assert.deepEqual(next.docks, [])

    // A state over two minutes old is not served: the question waits for a new one.
    failing = new Set()
    bikesDown = false
    bikesUpdated = new Date(clock).toISOString()
    frozen.set("nqrw", clock / 1000)
    clock += 180_000
    const fresh = await provider.get(null)
    assert.equal(fresh.time, new Date(clock).toISOString().replace(/\.000Z$/, "Z"))
    assert.equal(fresh.docks.length, FIXTURE_DOCKS.docks.length)
    assert.ok(fresh.lines.some((l) => l.id === "R"), "a feed three minutes old still counts")

    // Old data served while a source is down is left out, not presented as now.
    clock += 600_000
    const later = await provider.get(null)
    assert.ok(!later.lines.some((l) => ["N", "Q", "R", "W"].includes(l.id)), "a feed thirteen minutes old is left out")
    assert.ok(later.lines.some((l) => l.id === "F"))
    assert.deepEqual(later.docks, [], "docks thirteen minutes old are left out")
  } finally {
    warn.mock.restore()
  }
})

async function serve(routes: Route[]) {
  const middleware = routesMiddleware(routes)
  const server = createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 404
      res.end("not a route")
    }),
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return { base, close }
}

test("GET /api/city shows the state, and the ask panel says where its answers come from", async () => {
  const recorded = createRecordedProvider({
    mta: createMtaSource({ recordings: mkdtempSync(join(tmpdir(), "nyc-live-no-recordings-")), fixtures: FIXTURES_DIR }),
    recordedDocks: () => FIXTURE_DOCKS,
  })
  const provider = (mode: string): CityStateProvider => (mode === "recorded" ? recorded : fixtureProvider)
  const { base, close } = await serve([cityRoute(provider), ...createAskRoutes({ provider, apiKey: "" })])
  try {
    const t = "2026-10-18T23:02:17Z"
    const state = (await (await fetch(`${base}/api/city?mode=recorded&t=${t}`)).json()) as { source: string; time: string }
    assert.deepEqual([state.source, state.time], ["recorded", t])
    assert.equal(((await (await fetch(`${base}/api/city`)).json()) as { source: string }).source, "fixture")
    assert.equal((await fetch(`${base}/api/city?mode=live&t=soon`)).status, 400)
    const options = (await (await fetch(`${base}/api/ask?mode=recorded&t=${t}`)).json()) as AskOptions
    assert.deepEqual(options.state, { source: "recorded", time: t })
  } finally {
    await close()
  }
})

test("the URL follows a gliding camera, not only once it settles", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  try {
    const saved: number[] = []
    const follow = followCamera(() => saved.push(Date.now()), 250)
    // A fast pan, then damping: `change` every frame for 4 s after the finger lifts.
    for (let t = 0; t <= 1000; t += 16) {
      follow.moved()
      mock.timers.tick(16)
    }
    follow.ended()
    const lifted = Date.now()
    assert.equal(saved.at(-1), lifted, "saved when the drag ends")
    for (let t = 0; t <= 4000; t += 16) {
      follow.moved()
      mock.timers.tick(16)
      // Never more than a quarter second behind the camera while it moves.
      assert.ok(Date.now() - saved.at(-1)! <= 250 + 16, `${Date.now() - saved.at(-1)!} ms behind`)
    }
    const stopped = Date.now()
    const before = saved.length
    // Frame by frame, so a timer that fires reads the time it fired at.
    for (let t = 0; t < 300; t += 16) mock.timers.tick(16)
    // Once more after the last movement, then quiet.
    assert.equal(saved.length, before + 1)
    assert.ok(saved.at(-1)! - stopped <= 250 + 16)
    mock.timers.tick(5000)
    assert.equal(saved.length, before + 1)
  } finally {
    mock.timers.reset()
  }
})

test("the see-through subway fades out as the camera comes down to the street", () => {
  assert.equal(xrayFade(7.9), 0) // the Street level preset
  assert.equal(xrayFade(40), 0)
  assert.ok(xrayFade(120) > 0 && xrayFade(120) < 1)
  assert.equal(xrayFade(370.8), 1) // the lowest other preset, Brooklyn Bridge
})

test("recorded playback tells the view which moment is on screen", async () => {
  const subway = JSON.parse(readFileSync("public/fixtures/subway.json", "utf8")) as SubwayData
  const source = createMtaSource({ recordings: mkdtempSync(join(tmpdir(), "nyc-live-no-recordings-")), fixtures: FIXTURES_DIR })
  const layerIn = async (mode: "fixture" | "recorded" | "live", time: string | null) => {
    const layer = createTrainsLayer({
      loadSubway: async () => subway,
      loadFeed: async (feed, _mode, t) => source.recorded(feed, t == null ? null : Date.parse(t) / 1000)!,
    })
    const before = performance.now()
    await layer.init({ mode, time })
    return { layer, before, after: performance.now() }
  }
  const { layer, before, after } = await layerIn("recorded", "2026-10-18T23:11:12Z")
  // The clock started during init, at the URL's time, and plays on in real time.
  assert.ok(after - before < 1000, `init took ${Math.round(after - before)} ms`)
  assert.equal(playbackTime(layer, after), "2026-10-18T23:11:12Z")
  assert.equal(playbackTime(layer, after + 60_000), "2026-10-18T23:12:12Z")
  assert.equal(playbackTime((await layerIn("fixture", null)).layer), null)
  // Another layer has no playback clock.
  assert.equal(playbackTime(createVenueLayer()), null)
})

test("the status line drops a startup failure once the layer recovers", () => {
  let docks: string | null = null
  const layers = [
    { id: "ground", summary: () => "6,608 street segments" },
    { id: "buildings", summary: () => "670 buildings" },
    { id: "citibike", summary: () => docks },
    { id: "venue", summary: () => "598 Broadway" },
  ]
  const failures = new Map([["citibike", "Error: /api/citibike: HTTP 502"]])
  const quiet = new Set(["ground", "venue"])
  assert.equal(statusLine(layers, failures, quiet), "670 buildings · failed: citibike: Error: /api/citibike: HTTP 502")
  // A later retry draws the docks: their summary replaces the old failure, for good.
  docks = "235 Citi Bike docks · 8,067 bikes (3,537 e-bikes) at 19:57"
  assert.equal(statusLine(layers, failures, quiet), `670 buildings · ${docks}`)
  docks = null
  assert.equal(statusLine(layers, failures, quiet), "670 buildings")
  assert.equal(statusLine([], new Map()), "ready")
})

// A 1600x900 screen looking at a preset's view.
function cameraAt(cam: number[], tgt: number[]): PerspectiveCamera {
  const camera = new PerspectiveCamera(45, 1600 / 900, 1, 20000)
  camera.position.set(cam[0]!, cam[1]!, cam[2]!)
  camera.lookAt(new Vector3(tgt[0]!, tgt[1]!, tgt[2]!))
  camera.updateMatrixWorld()
  return camera
}

const screenY = (camera: PerspectiveCamera, p: readonly number[]) => ((1 - new Vector3(p[0], p[1], p[2]).project(camera).y) / 2) * 900

test("the venue's label stands above its pin and ring from any angle, straight down included", () => {
  const ring = VENUE_MARKER.slice(1)
  const views = [{ cam: [0, 1100, 1], tgt: [0, 0, 0] }, ...PRESETS.map((p) => p.view)]
  for (const { cam, tgt } of views) {
    const camera = cameraAt(cam, tgt)
    const top = venueMarkerTop(camera, 900)
    assert.ok(top != null, `${cam}: the marker is in view`)
    assert.ok(top <= screenY(camera, [0, 80, 0]) && ring.every((p) => top <= screenY(camera, p)), `${cam}: the label clears the marker`)
  }
  // From straight above the ring reaches higher on screen than the pin's head, so a
  // label standing on the head would cover the ring.
  const above = cameraAt([0, 1100, 1], [0, 0, 0])
  assert.ok(venueMarkerTop(above, 900)! < screenY(above, [0, 80, 0]) - 10)
})

test("the venue's pin and ring show through the buildings, over the see-through subway", async () => {
  const layer = createVenueLayer()
  await layer.init({ mode: "fixture", time: null })
  const marks = layer.group.children as Mesh[]
  assert.equal(marks.length, 2)
  for (const mark of marks) {
    const xray = mark.children[0] as Mesh
    const material = xray.material as MeshBasicMaterial
    assert.ok(xray.geometry === mark.geometry && !material.depthTest && !material.depthWrite && material.opacity < 1)
    assert.ok(xray.renderOrder > 1, "drawn after the see-through subway and the streets")
  }
})

type PlanStep = string | { text: string; copy?: Array<{ text: string }> }
type PlanFeature = { id: string; title: string; ticket: string; url: string; intro: string; steps: PlanStep[]; pass: string }

test("the morning review plan opens a view for every feature a person can see", () => {
  const plan = JSON.parse(readFileSync("plan/review-plan.json", "utf8")) as { title: string; features: PlanFeature[] }
  assert.ok(plan.title.length > 0)
  const ids = plan.features.map((f) => f.id)
  assert.deepEqual(ids, ["stage", "buildings", "ground", "subway", "trains", "citibike", "ask", "camera", "review"])
  assert.equal(new Set(ids).size, ids.length)
  const links: string[] = []
  for (const f of plan.features) {
    for (const key of ["title", "ticket", "url", "intro", "pass"] as const) assert.ok(f[key]?.length > 0, `${f.id} has no ${key}`)
    assert.ok(f.steps.length > 0, `${f.id} has no steps`)
    links.push(f.url)
    for (const step of f.steps) {
      const text = typeof step === "string" ? step : step.text
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) links.push(m[1]!)
    }
  }
  // Opened on the app through any proxy: a path on the app's own origin, never a host.
  for (const link of links) {
    assert.match(link, /^\/#cam=/, link)
    const view = parseViewState(link.slice(1))
    assert.equal(serializeViewState(view), link.slice(1), `${link} is not a view the app writes back unchanged`)
  }
  assert.doesNotMatch(readFileSync("plan/review-plan.json", "utf8"), /localhost|127\.0\.0\.1|https?:\/\//)
})

// test/fixtures/stage.png is the stage view (the Venue preset at night in recorded
// mode at 23:11:12Z, with the route question asked: the plan's first feature), and test/recordings/
// holds the Decisions API's real answers for it.
test("the recorded stage screenshot passes its checks: trains under the venue, a route answered", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(process.execPath, ["scripts/check-visual.ts", "test/fixtures/stage.png", "checks/stage.json", "--replay"], {
    encoding: "utf8",
    env,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 5, run.stdout)
})
