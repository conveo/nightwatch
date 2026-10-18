import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { env } from "node:process"
import { test } from "node:test"
import { routesMiddleware, type Route } from "../server/api.ts"
import {
  cityStateProvider,
  FIXTURE_CITY_STATE,
  fixtureProvider,
  nearby,
  setCityStateProvider,
  type CityState,
} from "../server/city-state.ts"
import type { Recording } from "../server/decisions.ts"
import { BadQuestion, createAskRoutes, parseQuestion, planQuestion, readAnswer } from "../server/routes/ask.ts"
import { askParam, parseAsk, percent } from "../src/ask/ask-param.ts"
import type { AskOptions, AskResponse } from "../src/ask/types.ts"
import { VENUE } from "../src/geo.ts"

// The route tests answer from the Decisions API's real answers, saved in
// test/recordings/, so they need no key. To record them again (after changing a
// template or the fixture), run once with a key:
//
//   NYC_LIVE_ASK_RECORD=1 node --env-file=<file with OPENAI_API_KEY> --test test/ask.test.ts
const recording: Recording = { dir: "test/recordings", mode: env.NYC_LIVE_ASK_RECORD === "1" ? "record" : "replay" }

const state = FIXTURE_CITY_STATE

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
  const ask = (body: unknown) =>
    fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  return { base, ask, close }
}

test("the fixture is consistent: every line has service, every place has a station", () => {
  const lines = new Set(state.lines.map((l) => l.id))
  assert.equal(lines.size, state.lines.length, "line ids are unique")
  for (const station of state.stations) {
    for (const line of station.lines) assert.ok(lines.has(line), `${station.name} serves ${line}, which has no service entry`)
  }
  for (const place of state.places) assert.ok(nearby(state.stations, place, 700).length > 0, `no station near ${place.name}`)
  assert.ok(nearby(state.docks, VENUE, 500).length > 0, "no dock near the venue")
})

test("a mode without its own provider answers from the fixture, and says so", async () => {
  assert.equal(cityStateProvider("live"), fixtureProvider)
  assert.equal((await cityStateProvider("recorded").get("2026-10-21T23:10:00Z")).source, "fixture")
  const live: CityState = { ...state, source: "live", time: "2026-10-22T12:00:00Z" }
  setCityStateProvider("live", { source: "live", get: async () => live })
  try {
    assert.equal(await cityStateProvider("live").get(null), live)
    assert.equal(cityStateProvider("fixture"), fixtureProvider)
  } finally {
    setCityStateProvider("live", fixtureProvider)
  }
})

test("questions are checked against the city state", () => {
  assert.deepEqual(parseQuestion({ template: "route", place: "brooklyn-bridge" }, state), {
    template: "route",
    place: "brooklyn-bridge",
  })
  assert.deepEqual(parseQuestion({ template: "line", line: "f" }, state), { template: "line", line: "F" })
  assert.deepEqual(parseQuestion({ template: "yesno", question: "  Any   bikes?  " }, state), {
    template: "yesno",
    question: "Any bikes?",
  })
  for (const bad of [
    { template: "route", place: "the moon" },
    { template: "line", line: "Z9" },
    { template: "line" },
    { template: "yesno", question: " " },
    { template: "yesno", question: "?".repeat(201) },
    { template: "weather" },
    null,
  ]) {
    assert.throws(() => parseQuestion(bad, state), BadQuestion, JSON.stringify(bad))
  }
})

test("a route question is one choice between shared lines, Citi Bike and walking", () => {
  const plan = planQuestion({ template: "route", place: "brooklyn-bridge" }, state)
  assert.equal(plan.request.questions.length, 1)
  const question = plan.request.questions[0]!
  assert.equal(question.type, "choice")
  const values = question.type === "choice" ? question.choices.map((c) => c.value) : []
  assert.deepEqual(values, ["R/W train", "6 train", "E train", "Citi Bike", "Walk"])
  assert.equal(plan.highlights["R/W train"], "line:R/W")
  assert.equal(plan.highlights.Walk, "walk")
  assert.match(plan.request.input as string, /fixture data/)
  assert.match(plan.request.input as string, /Trip: from the venue to Brooklyn Bridge, 1\.5 km to the south-west/)
})

test("lines between the same stations are one option unless their status differs", () => {
  const plan = planQuestion({ template: "route", place: "washington-square-park" }, state)
  const question = plan.request.questions[0]!
  const values = question.type === "choice" ? question.choices.map((c) => c.value) : []
  // The F shares the B/D/M's stations but is delayed in the fixture.
  assert.ok(values.includes("B/D/M train"), values.join(" | "))
  assert.ok(values.includes("F train"), values.join(" | "))
})

test("line and yes/no questions are one predicate each", () => {
  const line = planQuestion({ template: "line", line: "F" }, state)
  assert.deepEqual(line.request.questions.map((q) => [q.type, q.name]), [["predicate", "line_normal"]])
  assert.equal(line.question, "Is the F train running normally?")
  const yesno = planQuestion({ template: "yesno", question: "Is it busy?" }, state)
  assert.deepEqual(yesno.request.questions.map((q) => [q.type, q.name]), [["predicate", "yes_no"]])
  assert.equal(yesno.question, "Is it busy?")
})

test("answers become the most likely option and its probability", () => {
  const route = planQuestion({ template: "route", place: "brooklyn-bridge" }, state)
  const choice = readAnswer(route, {
    type: "choice",
    name: "route",
    choice: "6 train",
    probabilities: [
      { value: "Walk", probability: 0.1 },
      { value: "6 train", probability: 0.7 },
      { value: "Citi Bike", probability: 0.2 },
    ],
    confidence: 0.6,
  })
  assert.equal(choice.answer, "6 train")
  assert.equal(choice.probability, 0.7)
  assert.equal(choice.highlight, "line:6")
  assert.deepEqual(
    choice.options.map((o) => o.value),
    ["6 train", "Citi Bike", "Walk"],
  )
  const line = planQuestion({ template: "line", line: "F" }, state)
  const no = readAnswer(line, { type: "predicate", name: "line_normal", probability: 0.25 })
  assert.equal(no.answer, "No")
  assert.equal(no.probability, 0.75)
  assert.equal(no.highlight, "line:F")
  const empty = readAnswer(route, { type: "choice", name: "route", choice: "Walk", probabilities: [], confidence: 0 })
  assert.equal(empty.answer, null)
  const refused = readAnswer(line, { type: "refusal", name: "line_normal" })
  assert.equal(refused.answer, null)
  assert.equal(refused.probability, null)
})

test("POST /api/ask answers every template from recorded answers", async () => {
  const { ask, close } = await serve(createAskRoutes({ recording }))
  try {
    for (const question of [
      { template: "route", place: "brooklyn-bridge" },
      { template: "line", line: "F" },
      { template: "yesno", question: "Are there e-bikes at a dock near the venue?" },
    ]) {
      const res = await ask({ ...question, mode: "fixture" })
      const body = (await res.json()) as AskResponse
      assert.equal(res.status, 200, JSON.stringify(body))
      assert.equal(body.template, question.template)
      assert.ok(body.answer != null && body.probability != null, JSON.stringify(body))
      assert.equal(body.answer, body.options[0]!.value)
      assert.equal(body.probability, body.options[0]!.probability)
      assert.match(percent(body.probability), /^\d+%$/)
      assert.deepEqual(body.state, { source: "fixture", time: state.time })
    }
  } finally {
    await close()
  }
})

test("the recorded answers make sense for the fixture", async () => {
  const { ask, close } = await serve(createAskRoutes({ recording }))
  try {
    const route = (await (await ask({ template: "route", place: "brooklyn-bridge" })).json()) as AskResponse
    assert.equal(route.answer, "6 train")
    assert.equal(route.highlight, "line:6")
    const line = (await (await ask({ template: "line", line: "F" })).json()) as AskResponse
    assert.equal(line.answer, "No", "the F is delayed in the fixture")
  } finally {
    await close()
  }
})

test("a repeated question is answered from memory, well under a second", async () => {
  const { ask, close } = await serve(createAskRoutes({ recording }))
  try {
    const question = { template: "route", place: "brooklyn-bridge" }
    const first = (await (await ask(question)).json()) as AskResponse
    const started = performance.now()
    const second = (await (await ask(question)).json()) as AskResponse
    assert.equal(first.cached, false)
    assert.equal(second.cached, true)
    assert.equal(second.answer, first.answer)
    assert.ok(performance.now() - started < 1000)
  } finally {
    await close()
  }
})

test("bad questions are a 400, a missing key a 503, and neither reaches the API", async () => {
  const { ask, close } = await serve(createAskRoutes({ apiKey: "" }))
  try {
    assert.equal((await ask("{not json")).status, 400)
    assert.equal((await ask("null")).status, 400)
    assert.equal((await ask("[]")).status, 400)
    const unknown = await ask({ template: "route", place: "the moon" })
    assert.equal(unknown.status, 400)
    assert.match(((await unknown.json()) as { error: string }).error, /unknown place/)
    const noKey = await ask({ template: "line", line: "R" })
    assert.equal(noKey.status, 503)
    assert.deepEqual(await noKey.json(), { error: "the server has no OPENAI_API_KEY" })
  } finally {
    await close()
  }
})

test("GET /api/ask lists the places and lines to ask about", async () => {
  const { base, close } = await serve(createAskRoutes({ recording }))
  try {
    const options = (await (await fetch(`${base}/api/ask?mode=live`)).json()) as AskOptions
    assert.ok(options.places.some((p) => p.id === "brooklyn-bridge" && p.name === "Brooklyn Bridge"))
    assert.ok(options.lines.some((l) => l.id === "F" && l.status === "delays"))
    assert.equal(options.state.source, "fixture")
  } finally {
    await close()
  }
})

test("a question in the URL survives a round trip", () => {
  for (const q of [
    { template: "route", place: "brooklyn-bridge" },
    { template: "line", line: "F" },
    { template: "yesno", question: "Are there bikes: yes or no?" },
  ] as const) {
    assert.deepEqual(parseAsk(askParam(q)), q)
  }
  for (const bad of [null, "", "route", "route:", "weather:sunny"]) assert.equal(parseAsk(bad), null, String(bad))
})

// test/fixtures/ask.png is a real screenshot of the panel answering a route
// question, and test/recordings/ holds the Decisions API's real answers for it.
test("the recorded ask screenshot passes its checks", () => {
  const clean = { ...process.env }
  delete clean.OPENAI_API_KEY
  const run = spawnSync(process.execPath, ["scripts/check-visual.ts", "test/fixtures/ask.png", "checks/ask.json", "--replay"], {
    encoding: "utf8",
    env: clean,
  })
  assert.equal(run.status, 0, run.stderr + run.stdout)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 3, run.stdout)
})
