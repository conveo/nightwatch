import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { formatAsk, parseAsk, questionText, slugify, type AskAnswer, type AskFailure } from "../src/ask/templates.ts"
import { DEFAULT_VIEW, parseViewState, serializeViewState } from "../src/view-state.ts"
import { loadRoutes, routesMiddleware, type Route } from "../server/api.ts"
import type { CityState } from "../server/city-state.ts"
import { FIXTURE_CITY_STATE } from "../server/city-state-fixture.ts"
import { recordingKey, type DecisionRequest, type DecisionResponse } from "../server/decisions.ts"
import { AskError, createAskRoute, parkAt, planAsk, readRecordings } from "../server/routes/ask.ts"

const noKey = () => undefined

async function serve(route: Route) {
  const middleware = routesMiddleware([route])
  const server = createServer((req, res) => middleware(req, res, () => res.writeHead(404).end()))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (body: unknown) => {
    const res = await fetch(`${base}/api/ask`, { method: "POST", body: JSON.stringify(body) })
    return { status: res.status, text: await res.text() }
  }
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return { post, close }
}

test("slugs follow the contract: lower case, ASCII, words joined by -", () => {
  assert.equal(slugify("Sint-Michiels"), "sint-michiels")
  assert.equal(slugify("P+R The Loop"), "p-r-the-loop")
  assert.equal(slugify("The Loop - Parking D"), "the-loop-parking-d")
  assert.equal(slugify("François Laurentplein"), "francois-laurentplein")
  assert.equal(slugify("Portus Ganda"), "portus-ganda")
  assert.equal(slugify("ﬁets  –  Ü"), "fiets-u")
  assert.equal(slugify("-1 De Krook (underground)"), "1-de-krook-underground")
})

// The parking layer's (T5) slugs for tonight's feed, exactly.
test("garage slugs match the parking layer's for every garage in the feed", () => {
  const t5: Record<string, string> = {
    "B-Park Dampoort": "b-park-dampoort",
    "B-Park Gent Sint-Pieters": "b-park-gent-sint-pieters",
    "Dok noord": "dok-noord",
    Getouw: "getouw",
    Ledeberg: "ledeberg",
    "P+R The Loop": "p-r-the-loop",
    Ramen: "ramen",
    Reep: "reep",
    Savaan: "savaan",
    "Sint-Michiels": "sint-michiels",
    "Sint-Pietersplein": "sint-pietersplein",
    "The Loop": "the-loop",
    "The Loop - Parking D": "the-loop-parking-d",
    Tolhuis: "tolhuis",
    Vrijdagmarkt: "vrijdagmarkt",
  }
  for (const [name, slug] of Object.entries(t5)) assert.equal(slugify(name), slug, name)
  assert.deepEqual(
    Object.fromEntries(FIXTURE_CITY_STATE.garages.map((g) => [g.name, g.slug])),
    t5,
  )
})

test("questions parse from the URL and format back unchanged", () => {
  for (const ask of ["park:gravensteen", "drive:coupure~portus-ganda", "busy:now", "q:Is there space at Sint-Michiels?"]) {
    const question = parseAsk(ask)
    assert.ok(question, ask)
    assert.equal(formatAsk(question), ask)
  }
  assert.deepEqual(parseAsk("drive:kuip~krook"), { template: "drive", from: "kuip", to: "krook" })
  for (const bad of [null, "", "park", "park:", "park:Gravensteen", "drive:kuip", "drive:a~b~c", "busy:later", "q:  ", `q:${"x".repeat(201)}`, "where:now"]) {
    assert.equal(parseAsk(bad), null, String(bad))
  }
  assert.equal(questionText(parseAsk("busy:now")!), "Is the centre busy right now?")
  assert.equal(questionText(parseAsk("q:is it busy")!), "is it busy?")
})

test("a free question survives a round trip through the URL hash", () => {
  const ask = "q:Can I park at P+R The Loop, or is it full? 100% sure & fast"
  const hash = serializeViewState({ ...DEFAULT_VIEW, ask })
  assert.equal(parseViewState(hash).ask, ask)
  assert.equal(parseViewState(serializeViewState({ ...DEFAULT_VIEW, ask: "drive:coupure~portus-ganda" })).ask, "drive:coupure~portus-ganda")
  assert.match(serializeViewState({ ...DEFAULT_VIEW, ask: "drive:coupure~portus-ganda" }), /ask=drive:coupure~portus-ganda$/)
})

test("the fixture city state uses the contract's slugs", () => {
  const slugs = FIXTURE_CITY_STATE.garages.map((g) => g.slug)
  assert.equal(new Set(slugs).size, slugs.length)
  for (const g of FIXTURE_CITY_STATE.garages) {
    assert.equal(g.slug, slugify(g.name), g.name)
    assert.ok(g.available >= 0 && g.available <= g.capacity, g.name)
  }
  assert.ok(slugs.includes("vrijdagmarkt") && slugs.includes("sint-michiels"))
  assert.deepEqual(FIXTURE_CITY_STATE.sectors.map(slugify), ["kuip", "coupure", "tolhuis", "portus-ganda", "krook", "rabot", "brugse-poort"])
  assert.ok(FIXTURE_CITY_STATE.bikes.every((b) => b.operator === "donkey" && /^\d+$/.test(b.id)))
  assert.ok(FIXTURE_CITY_STATE.places.some((p) => p.slug === "gravensteen"))
})

test("a parking question offers the nearest garages with space and a shared bike", () => {
  const plan = planAsk(parseAsk("park:gravensteen")!, FIXTURE_CITY_STATE)
  assert.equal(plan.kind, "choice")
  assert.equal(plan.question, "Where should I park to reach Gravensteen?")
  const values = plan.options.map((o) => o.value)
  assert.deepEqual(values.slice(0, 3), ["garage:ramen", "garage:vrijdagmarkt", "garage:sint-michiels"])
  assert.match(values[3]!, /^bikes:donkey:\d+$/)
  const question = plan.request.questions[0]!
  assert.equal(question.type, "choice")
  assert.deepEqual(question.type === "choice" ? question.choices.map((c) => c.value) : [], values)

  // A full garage is never offered, however close.
  const ramenFull: CityState = {
    ...FIXTURE_CITY_STATE,
    garages: FIXTURE_CITY_STATE.garages.map((g) => (g.slug === "ramen" ? { ...g, available: 0 } : g)),
  }
  assert.ok(!planAsk(parseAsk("park:gravensteen")!, ramenFull).options.some((o) => o.value === "garage:ramen"))

  // Only the garages drawn on the map are offered, from every place.
  const onMap = new Set(["garage:ramen", "garage:reep", "garage:savaan", "garage:sint-michiels", "garage:vrijdagmarkt"])
  for (const place of FIXTURE_CITY_STATE.places) {
    const offered = planAsk({ template: "park", place: place.slug }, FIXTURE_CITY_STATE).options.filter((o) => o.value.startsWith("garage:"))
    assert.equal(offered.length, 3, place.slug)
    assert.ok(offered.every((o) => onMap.has(o.value)), `${place.slug}: ${offered.map((o) => o.value).join(", ")}`)
  }
  // With every garage on the map full, the nearest one off it is offered, and says so.
  const mapFull: CityState = {
    ...FIXTURE_CITY_STATE,
    garages: FIXTURE_CITY_STATE.garages.map((g) => (onMap.has(`garage:${g.slug}`) ? { ...g, available: 0 } : g)),
  }
  const offMap = planAsk(parseAsk("park:gravensteen")!, mapFull).options[0]!
  assert.ok(!onMap.has(offMap.value) && offMap.value.startsWith("garage:"))
  assert.match(offMap.detail, /off the map$/)
})

test("unknown places and sectors are a plain 400", () => {
  assert.throws(() => planAsk(parseAsk("park:atomium")!, FIXTURE_CITY_STATE), (e: AskError) => e.status === 400 && /atomium/.test(e.message))
  assert.throws(
    () => planAsk(parseAsk("drive:kuip~sector-zuid")!, FIXTURE_CITY_STATE),
    (e: AskError) => e.status === 400 && /sector-zuid/.test(e.message) && /portus-ganda/.test(e.message),
  )
})

test("every recorded answer still matches the request the route sends", async () => {
  const recordings = await readRecordings()
  const asks = Object.values(recordings).map((r) => r.ask)
  for (const ask of ["park:gravensteen", "busy:now", "drive:coupure~portus-ganda"]) assert.ok(asks.includes(ask), ask)
  for (const [key, recording] of Object.entries(recordings)) {
    const plan = planAsk(parseAsk(recording.ask)!, FIXTURE_CITY_STATE)
    assert.equal(recordingKey(plan.request), key, `${recording.ask}: record it again`)
  }
})

test("without a key, the template questions answer from the recordings (replay)", async () => {
  const route = createAskRoute({ apiKey: noKey })
  const park = await route.ask({ ask: "park:gravensteen", mode: "fixture", time: null })
  assert.equal(park.source, "recorded")
  assert.equal(park.kind, "choice")
  assert.match(park.sel ?? "", /^garage:/)
  assert.equal(park.answer, parkAt(park.options[0]!.label))
  assert.equal(parkAt("Ramen"), "Park at the Ramen garage")
  assert.equal(parkAt("The Loop"), "Park at The Loop garage")
  assert.ok(park.probability > 0 && park.probability <= 1)
  assert.equal(park.dataTime, FIXTURE_CITY_STATE.time)

  const busy = await route.ask({ ask: "busy:now", mode: "fixture", time: null })
  assert.equal(busy.kind, "predicate")
  assert.equal(busy.answer, "No")
  assert.equal(busy.sel, null)
  // The circulation plan sends traffic between sectors out onto the R40.
  const drive = await route.ask({ ask: "drive:coupure~portus-ganda", mode: "fixture", time: null })
  assert.equal(drive.answer, "No")
  assert.ok(drive.probability >= 0.8)
})

test("a question with no recording and no key says so plainly", async () => {
  const { post, close } = await serve(createAskRoute({ apiKey: noKey }))
  try {
    const missing = await post({ ask: "q:Is it raining?" })
    assert.equal(missing.status, 503)
    const body = JSON.parse(missing.text) as AskFailure
    assert.equal(body.question, "Is it raining?")
    assert.match(body.error, /No recorded answer.*no OPENAI_API_KEY/)

    const bad = await post({ ask: "<script>" })
    assert.equal(bad.status, 400)
    assert.equal((JSON.parse(bad.text) as AskFailure).ask, "")
    assert.ok(!bad.text.includes("<script>"))
  } finally {
    await close()
  }
})

test("a warm request answers in well under a second", async () => {
  let calls = 0
  const fake = async (request: DecisionRequest): Promise<DecisionResponse> => {
    calls++
    return { model: "fake", answers: [{ type: "predicate", name: request.questions[0]!.name, probability: 0.9 }] }
  }
  const { post, close } = await serve(createAskRoute({ apiKey: () => "sk-test", decide: fake }))
  const replay = await serve(createAskRoute({ apiKey: noKey }))
  try {
    const first = JSON.parse((await post({ ask: "busy:now" })).text) as AskAnswer
    assert.equal(first.source, "live")
    assert.equal(first.answer, "Yes")
    const started = performance.now()
    const warm = JSON.parse((await post({ ask: "busy:now" })).text) as AskAnswer
    assert.equal(warm.source, "cached")
    assert.equal(calls, 1)
    assert.ok(performance.now() - started < 1000)

    await replay.post({ ask: "park:gravensteen" })
    const again = performance.now()
    assert.equal((await replay.post({ ask: "park:gravensteen" })).status, 200)
    assert.ok(performance.now() - again < 1000)
  } finally {
    await close()
    await replay.close()
  }
})

test("the key and the upstream body never reach the browser", async () => {
  const leaky = async (): Promise<DecisionResponse> => {
    throw new Error('Decisions API answered HTTP 401: {"error": "Incorrect API key provided: sk-test-secret"}')
  }
  const slow = () => new Promise<DecisionResponse>(() => {})
  const a = await serve(createAskRoute({ apiKey: () => "sk-test-secret", decide: leaky }))
  const b = await serve(createAskRoute({ apiKey: () => "sk-test-secret", decide: slow, timeoutMs: 50 }))
  try {
    const failed = await a.post({ ask: "busy:now" })
    assert.equal(failed.status, 502)
    assert.equal((JSON.parse(failed.text) as AskFailure).error, "The Decisions API answered HTTP 401.")
    assert.ok(!failed.text.includes("sk-test"))
    const ok = await serve(createAskRoute({ apiKey: () => "sk-test-secret", decide: async (r) => ({ model: "fake", answers: [{ type: "predicate", name: r.questions[0]!.name, probability: 0.2 }] }) }))
    try {
      const answered = await ok.post({ ask: "busy:now" })
      assert.ok(!answered.text.includes("sk-test") && !answered.text.includes("questions") && !answered.text.includes("Circulation plan"))
    } finally {
      await ok.close()
    }
    const timedOut = await b.post({ ask: "busy:now" })
    assert.equal(timedOut.status, 504)
  } finally {
    await a.close()
    await b.close()
  }
})

test("a body that is not a JSON object is a plain 400", async () => {
  const { post, close } = await serve(createAskRoute({ apiKey: noKey }))
  try {
    for (const body of [null, [], 42, "park:gravensteen"]) {
      const res = await post(body)
      assert.equal(res.status, 400, JSON.stringify(body))
      assert.match((JSON.parse(res.text) as AskFailure).error, /Send JSON like/)
    }
  } finally {
    await close()
  }
})

test("a timed-out upstream request is aborted, not left running", async () => {
  let aborted: unknown = null
  const hanging = (_request: DecisionRequest, options: { signal: AbortSignal }) =>
    new Promise<DecisionResponse>((_, reject) => {
      options.signal.addEventListener("abort", () => {
        aborted = options.signal.reason
        reject(new Error("aborted"))
      })
    })
  const route = createAskRoute({ apiKey: () => "sk-test", decide: hanging, timeoutMs: 50 })
  await assert.rejects(route.ask({ ask: "busy:now" }), (e: AskError) => e.status === 504)
  assert.ok(aborted instanceof AskError && aborted.status === 504)
})

test("the same question asked twice at once calls the API once", async () => {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const slow = async (request: DecisionRequest): Promise<DecisionResponse> => {
    calls++
    await gate
    return { model: "fake", answers: [{ type: "predicate", name: request.questions[0]!.name, probability: 0.1 }] }
  }
  const route = createAskRoute({ apiKey: () => "sk-test", decide: slow })
  const both = Promise.all([route.ask({ ask: "busy:now" }), route.ask({ ask: "busy:now" })])
  release()
  const [a, b] = await both
  assert.equal(calls, 1)
  assert.equal(a.answer, "No")
  assert.equal(b.answer, "No")
  assert.equal((await route.ask({ ask: "busy:now" })).source, "cached")
  assert.equal(calls, 1)
})

test("the route is mounted with the others", async () => {
  const routes = await loadRoutes(fileURLToPath(new URL("../server/routes", import.meta.url)))
  assert.ok(routes.some((r) => r.method === "POST" && r.path === "/api/ask"))
})

// test/fixtures/ask.png is a real screenshot of `#ask=park:gravensteen` in fixture
// mode, and test/recordings/ holds the Decisions API's real answers for it.
test("the recorded ask screenshot passes its checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(process.execPath, ["scripts/check-visual.ts", "test/fixtures/ask.png", "checks/ask.json", "--replay"], {
    encoding: "utf8",
    env,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 4, run.stdout)
})
