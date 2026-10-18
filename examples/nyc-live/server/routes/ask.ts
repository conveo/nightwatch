// POST /api/ask: one question about the city, answered by the OpenAI Decisions API
// from the current city state, with probabilities. GET /api/ask lists the places
// and lines the panel can offer. The key is read here, on the server, and never
// reaches the browser.
//
// Each template plus the city state becomes exactly one Decisions request:
//   route  "the fastest way from the venue to <place>"  (choice: a subway line, Citi Bike or walk)
//   line   "does the <line> run normally?"               (predicate)
//   yesno  a free yes/no question about the state       (predicate)

import { readJson, sendJson, type Route } from "../api.ts"
import {
  cityStateProvider,
  distanceM,
  nearby,
  type CityState,
  type CityStateProvider,
  type LineService,
  type Place,
  type Station,
} from "../city-state.ts"
import { DECISIONS_MODEL, decide, recordingKey, type Answer, type DecisionRequest, type Recording } from "../decisions.ts"
import { toLocal, VENUE } from "../../src/geo.ts"
import { YESNO_MAX_LENGTH, type AskOptions, type AskQuestion, type AskResponse } from "../../src/ask/types.ts"
import type { DataMode } from "../../src/view-state.ts"

// "Near" for stations and docks, in straight-line metres.
const STATION_RADIUS_M = 700
const DOCK_RADIUS_M = 500

export class BadQuestion extends Error {}

const MODES: readonly DataMode[] = ["fixture", "recorded", "live"]

function parseMode(raw: unknown): DataMode {
  return MODES.includes(raw as DataMode) ? (raw as DataMode) : "fixture"
}

function parseTime(raw: unknown): string | null {
  return typeof raw === "string" && !Number.isNaN(Date.parse(raw)) ? raw : null
}

// Checks a request body against the city state: only places and lines the state
// knows, and a short yes/no question.
export function parseQuestion(body: unknown, state: CityState): AskQuestion {
  const b = (body ?? {}) as Record<string, unknown>
  switch (b.template) {
    case "route": {
      const place = state.places.find((p) => p.id === b.place)
      if (place == null) throw new BadQuestion(`unknown place ${JSON.stringify(b.place)}`)
      return { template: "route", place: place.id }
    }
    case "line": {
      const line = state.lines.find((l) => typeof b.line === "string" && l.id === b.line.toUpperCase())
      if (line == null) throw new BadQuestion(`unknown line ${JSON.stringify(b.line)}`)
      return { template: "line", line: line.id }
    }
    case "yesno": {
      const question = typeof b.question === "string" ? b.question.replace(/\s+/g, " ").trim() : ""
      if (question.length < 3) throw new BadQuestion("the question is empty")
      if (question.length > YESNO_MAX_LENGTH) throw new BadQuestion(`the question is longer than ${YESNO_MAX_LENGTH} characters`)
      return { template: "yesno", question }
    }
    default:
      throw new BadQuestion(`unknown template ${JSON.stringify(b.template)}; use route, line or yesno`)
  }
}

function metres(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]

// x is east and z is south, so north is -z.
function direction(to: Place): string {
  const { x, z } = toLocal(to)
  const bearing = (Math.atan2(x, -z) * 180) / Math.PI
  return COMPASS[Math.round(((bearing + 360) % 360) / 45) % 8]!
}

const SOURCES: Record<DataMode, string> = {
  fixture: "fixture data (a hand-made sample, not live)",
  recorded: "a recorded feed",
  live: "the live feeds",
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function stationLine(s: { name: string; lines: string[]; distanceM: number }): string {
  return `- ${s.name} (${s.lines.join(", ")}), ${metres(s.distanceM)} away`
}

function dockLine(d: CityState["docks"][number] & { distanceM: number }): string {
  return `- ${d.name}, ${metres(d.distanceM)} away: ${count(d.bikes, "bike")} and ${count(d.ebikes, "e-bike")}, ${count(d.freeDocks, "free dock")}`
}

function serviceLine(l: CityState["lines"][number]): string {
  const every = l.headwayMin == null ? "no trains running" : `a train every ${l.headwayMin} min`
  return `- ${l.id}: ${l.status}, ${every}${l.note == null ? "" : ` (${l.note})`}`
}

// The part of every request that describes the city: what is near the venue and
// how the lines and docks are doing.
export function describeState(state: CityState): string {
  const stations = nearby(state.stations, VENUE, STATION_RADIUS_M)
  const docks = nearby(state.docks, VENUE, DOCK_RADIUS_M)
  return [
    `City state for lower Manhattan at ${state.time}, from ${SOURCES[state.source]}.`,
    "The venue is 598 Broadway, between Houston St and Prince St. The person asking is at the venue.",
    "",
    `Subway stations within ${metres(STATION_RADIUS_M)} of the venue:`,
    ...stations.map(stationLine),
    "",
    "Subway service now:",
    ...state.lines.map(serviceLine),
    "",
    `Citi Bike docks within ${metres(DOCK_RADIUS_M)} of the venue:`,
    ...(docks.length === 0 ? ["- none"] : docks.map(dockLine)),
    "",
    "Typical speeds: walking 80 m a minute, Citi Bike 250 m a minute, subway 500 m a minute between stations,",
    "plus on average half the time between trains to wait. Distances are straight lines; streets add about a quarter.",
  ].join("\n")
}

export type Plan = {
  request: DecisionRequest
  // The question as the panel shows it.
  question: string
  // For a choice: what each option highlights in the scene. For a predicate: what
  // a "yes" highlights.
  highlights: Record<string, string>
}

function routePlan(state: CityState, place: Place): Plan {
  const fromStations = nearby(state.stations, VENUE, STATION_RADIUS_M)
  const toStations = nearby(state.stations, place, STATION_RADIUS_M)
  const fromDocks = nearby(state.docks, VENUE, DOCK_RADIUS_M)
  const toDocks = nearby(state.docks, place, DOCK_RADIUS_M)

  // A line is an option when it stops both near the venue and near the place (one
  // seat, no changes), from the nearest such station on each side. Lines that run
  // between the same two stations with the same status are one option ("R/W"), so
  // trains sharing a track do not split the answer's probability between them.
  const groups = new Map<string, { from: Station & { distanceM: number }; to: Station & { distanceM: number }; lines: LineService[] }>()
  for (const line of state.lines) {
    const from = fromStations.find((s) => s.lines.includes(line.id))
    const to = toStations.find((s) => s.lines.includes(line.id))
    if (from == null || to == null) continue
    const key = `${from.id} ${to.id} ${line.status}`
    const group = groups.get(key)
    if (group == null) groups.set(key, { from, to, lines: [line] })
    else group.lines.push(line)
  }
  const choices: Array<{ value: string; description: string }> = []
  const highlights: Record<string, string> = {}
  for (const { from, to, lines } of groups.values()) {
    const ids = lines.map((l) => l.id).join("/")
    const every = lines.map((l) => (l.headwayMin == null ? `no ${l.id} trains` : `${l.id} every ${l.headwayMin} min`)).join(", ")
    const value = `${ids} train`
    choices.push({
      value,
      description: `From ${from.name} (${metres(from.distanceM)} from the venue) to ${to.name} (${metres(to.distanceM)} from ${place.name}); ${lines[0]!.status}: ${every}.`,
    })
    highlights[value] = `line:${ids}`
  }
  const bikes = fromDocks.reduce((n, d) => n + d.bikes + d.ebikes, 0)
  const free = toDocks.reduce((n, d) => n + d.freeDocks, 0)
  choices.push({
    value: "Citi Bike",
    description: `Ride from a dock near the venue (${count(bikes, "bike")} there now) to a dock near ${place.name} (${count(free, "free dock")} there now).`,
  })
  highlights["Citi Bike"] = "citibike"
  const distance = distanceM(place)
  choices.push({ value: "Walk", description: `Walk all the way: ${metres(distance)} in a straight line.` })
  highlights.Walk = "walk"

  const trip = [
    `Trip: from the venue to ${place.name}, ${metres(distance)} to the ${direction(place)} in a straight line.`,
    "",
    `Subway stations within ${metres(STATION_RADIUS_M)} of ${place.name}:`,
    ...(toStations.length === 0 ? ["- none"] : toStations.map(stationLine)),
    "",
    `Citi Bike docks within ${metres(DOCK_RADIUS_M)} of ${place.name}:`,
    ...(toDocks.length === 0 ? ["- none"] : toDocks.map(dockLine)),
  ]
  return {
    question: `What is the fastest way from 598 Broadway to ${place.name}?`,
    highlights,
    request: {
      model: DECISIONS_MODEL,
      input: [describeState(state), "", ...trip].join("\n"),
      questions: [
        {
          type: "choice",
          name: "route",
          instructions: `Which is the fastest way to get from the venue to ${place.name} right now, door to door, counting the walk to and from the station or dock and the wait?`,
          choices,
        },
      ],
    },
  }
}

// The one Decisions request for a question.
export function planQuestion(question: AskQuestion, state: CityState): Plan {
  switch (question.template) {
    case "route":
      return routePlan(state, state.places.find((p) => p.id === question.place)!)
    case "line":
      return {
        question: `Is the ${question.line} train running normally?`,
        highlights: { Yes: `line:${question.line}`, No: `line:${question.line}` },
        request: {
          model: DECISIONS_MODEL,
          input: describeState(state),
          questions: [
            {
              type: "predicate",
              name: "line_normal",
              instructions: `The ${question.line} train is running normally right now: no delays, no reduced service and no suspension.`,
            },
          ],
        },
      }
    case "yesno":
      return {
        question: question.question,
        highlights: {},
        request: {
          model: DECISIONS_MODEL,
          input: describeState(state),
          questions: [
            {
              type: "predicate",
              name: "yes_no",
              instructions: `Judging only from the city state, the answer to this question is yes: ${question.question}`,
            },
          ],
        },
      }
  }
}

// The answer, its probability and every option's, most likely first. A refusal or
// an answer of the wrong type leaves `answer` null.
export function readAnswer(plan: Plan, answer: Answer | undefined): Pick<AskResponse, "answer" | "probability" | "options" | "highlight"> {
  let options: Array<{ value: string; probability: number }> = []
  if (answer?.type === "choice") {
    options = answer.probabilities.map((o) => ({ value: String(o.value), probability: o.probability }))
  } else if (answer?.type === "predicate") {
    options = [
      { value: "Yes", probability: answer.probability },
      { value: "No", probability: 1 - answer.probability },
    ]
  } else {
    return { answer: null, probability: null, options: [], highlight: null }
  }
  options.sort((a, b) => b.probability - a.probability)
  const best = options[0]
  if (best == null) return { answer: null, probability: null, options: [], highlight: null }
  return { answer: best.value, probability: best.probability, options, highlight: plan.highlights[best.value] ?? null }
}

export type AskRouteOptions = {
  provider?: (mode: DataMode) => CityStateProvider
  apiKey?: string
  recording?: Recording
  // How long an identical question about an identical state is answered from memory.
  cacheMs?: number
}

const CACHE_LIMIT = 200

export function createAskRoutes(options: AskRouteOptions = {}): Route[] {
  const provider = options.provider ?? cityStateProvider
  const cacheMs = options.cacheMs ?? 60_000
  // Keyed by the whole Decisions request, so a new city state is a new question.
  // Holding the promise also folds identical questions asked at once into one call.
  const cache = new Map<string, { at: number; answer: Promise<Answer | undefined> }>()

  async function answerFor(request: DecisionRequest): Promise<{ answer: Answer | undefined; cached: boolean }> {
    const key = recordingKey(request)
    const hit = cache.get(key)
    if (hit != null && Date.now() - hit.at < cacheMs) return { answer: await hit.answer, cached: true }
    const answer = decide(request, { apiKey: options.apiKey, recording: options.recording }).then((r) => r.answers[0])
    cache.set(key, { at: Date.now(), answer })
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    // A failed answer is forgotten, unless a newer one has taken its place.
    answer.catch(() => cache.get(key)?.answer === answer && cache.delete(key))
    return { answer: await answer, cached: false }
  }

  const list: Route = {
    method: "GET",
    path: "/api/ask",
    async handle(_req, res, url) {
      const state = await provider(parseMode(url.searchParams.get("mode"))).get(parseTime(url.searchParams.get("t")))
      const body: AskOptions = {
        places: state.places.map((p) => ({ id: p.id, name: p.name })),
        lines: state.lines.map((l) => ({ id: l.id, color: l.color, status: l.status })),
        state: { source: state.source, time: state.time },
      }
      sendJson(res, 200, body)
    },
  }

  const ask: Route = {
    method: "POST",
    path: "/api/ask",
    async handle(req, res) {
      const started = performance.now()
      let body: Record<string, unknown>
      try {
        body = await readJson<Record<string, unknown>>(req, 4096)
      } catch (error) {
        return sendJson(res, 400, { error: `not a JSON question: ${(error as Error).message}` })
      }
      if (typeof body !== "object" || body == null || Array.isArray(body)) {
        return sendJson(res, 400, { error: "not a JSON question: send an object" })
      }
      const state = await provider(parseMode(body.mode)).get(parseTime(body.t))
      let question: AskQuestion
      try {
        question = parseQuestion(body, state)
      } catch (error) {
        if (error instanceof BadQuestion) return sendJson(res, 400, { error: error.message })
        throw error
      }
      const plan = planQuestion(question, state)
      let result: { answer: Answer | undefined; cached: boolean }
      try {
        result = await answerFor(plan.request)
      } catch (error) {
        // The upstream error stays in the server log: its text can quote part of the key.
        const message = (error as Error).message
        console.error(`/api/ask: ${message}`)
        if (/OPENAI_API_KEY/.test(message)) return sendJson(res, 503, { error: "the server has no OPENAI_API_KEY" })
        const status = /HTTP (\d+)/.exec(message)?.[1]
        return sendJson(res, 502, { error: `the Decisions API did not answer${status == null ? "" : ` (HTTP ${status})`}` })
      }
      const response: AskResponse = {
        template: question.template,
        question: plan.question,
        ...readAnswer(plan, result.answer),
        state: { source: state.source, time: state.time },
        ms: Math.round(performance.now() - started),
        cached: result.cached,
      }
      sendJson(res, 200, response)
    },
  }

  return [list, ask]
}

export default createAskRoutes()
