// POST /api/ask: "ask Ghent". Turns a question from the URL (`park:gravensteen`,
// `drive:coupure~portus-ganda`, `busy:now`, `q:<text>`; see src/ask/templates.ts)
// plus the current city state into one Decisions API request, and returns the
// answer with its probabilities.
//
// With OPENAI_API_KEY on the server it asks the API. Without one it answers from
// the committed recordings in server/ask-recordings.json (the fixture city state's
// template questions), and says so plainly when it has none for a question. The key
// never leaves this process: the browser gets the answer, never the request.
//
// Only JSON from the app's own page is answered (a paid question per request): a
// body sent as anything but application/json is refused before it is read, and so is
// a request from another site's page (see sameOriginOrAllowed).
//
// After changing a prompt or the fixture, record every question again (needs the
// key; the file is rewritten with exactly these questions, so stale answers go):
//
//   node server/routes/ask.ts --record park:gravensteen busy:now drive:coupure~portus-ganda

import { readFile, writeFile } from "node:fs/promises"
import type { IncomingMessage } from "node:http"
import process, { env } from "node:process"
import { fileURLToPath } from "node:url"
import {
  formatAsk,
  parseAsk,
  questionText,
  slugify,
  type AskAnswer,
  type AskFailure,
  type AskOption,
  type AskQuestion,
  type AskRequest,
  type Names,
} from "../../src/ask/templates.ts"
import { inArea } from "../../src/constants.ts"
import { ORIGIN, toLocal, type LatLon } from "../../src/geo.ts"
import { readJson, sendJson, type Route } from "../api.ts"
import type { CityState, CityStateProvider, GarageState } from "../city-state.ts"
import { fixtureCityState } from "../city-state-fixture.ts"
import { CityStateError, modeCityState, type LiveCityState } from "../city-state-live.ts"
import {
  DECISIONS_MODEL,
  DECISIONS_URL,
  decide,
  recordingKey,
  type DecisionRequest,
  type DecisionResponse,
} from "../decisions.ts"

export const RECORDINGS_FILE = fileURLToPath(new URL("../ask-recordings.json", import.meta.url))

// One deadline for the whole question, from the moment the request arrives: reading
// the body, the city's data and the Decisions call. The panel stops waiting after 8 s
// (ANSWER_TIMEOUT_MS in src/ask/panel.ts), so the server answers, or says why not, by
// 7 s, leaving a second for the answer to reach the panel.
export const ASK_DEADLINE_MS = 7_000
// The Decisions request is not started with less than this left of the deadline: it
// would most likely be cut off after it had cost a request.
export const MIN_DECIDE_MS = 1_000
// The same question on the same data within this time is answered from memory.
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 200
// Garages within this distance of the Belfry count as the centre's for `busy:now`.
const CENTRE_RADIUS_M = 1_500
// How many garages a parking question offers, nearest first.
const PARK_GARAGES = 3

// What the route answers: the panel's AskAnswer, plus a line about the data when the
// city state has one (for example "Bolt bikes left out: …", from the live provider).
export type AskReply = AskAnswer & { notice?: string }

export class AskError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// One question, ready to send: the request and what its answers mean.
export type AskPlan = {
  ask: string
  question: string
  kind: "choice" | "predicate"
  request: DecisionRequest
  options: Array<Omit<AskOption, "probability">>
  // For a predicate, a line under the yes or no.
  detail: string
}

const metres = (a: LatLon, b: LatLon) => {
  const pa = toLocal(a)
  const pb = toLocal(b)
  return Math.hypot(pa.x - pb.x, pa.z - pb.z)
}
const roundTo = (m: number, step: number) => Math.round(m / step) * step
const distance = (m: number) => (m < 1000 ? `${roundTo(m, 10)} m` : `${(m / 1000).toFixed(1)} km`)
const percent = (p: number) => `${Math.round(p * 100)}%`
const full = (g: GarageState) => (g.capacity > 0 ? 1 - g.available / g.capacity : 1)

function namesFor(state: CityState): Names {
  return {
    place: (slug) => state.places.find((p) => p.slug === slug)?.nl ?? null,
    // Sector names become `sector:<slug>` slugs by the contract rule.
    sector: (slug) => state.sectors.find((s) => slugify(s) === slug) ?? null,
  }
}


const CIRCULATION =
  "Circulation plan: the R40 ring road circles the historic centre. Inside the ring, the Kuip is the car-free core: " +
  "cars may enter it only with a permit. The rest of the area inside the ring is divided into sectors. A car cannot " +
  "drive straight from one sector to another, or through the Kuip: it has to leave its sector onto the R40, follow " +
  "the ring, and enter the other sector from there. Within one sector, cars drive freely."

// The city state as text, distances measured from `from`.
// A city state may carry a line about its data (a stale or failed feed, from
// server/city-state-live.ts); the question then states it too, so the answer weighs it.
type StateWithNotice = CityState & { notice?: string; missing?: LiveCityState["missing"] }

function cityContext(state: StateWithNotice, from: { name: string } & LatLon): string {
  const garages = [...state.garages]
    .map((g) => ({ g, m: metres(g, from) }))
    .sort((a, b) => a.m - b.m)
    .map(
      ({ g, m }) =>
        `- ${g.name}: ${g.available} of ${g.capacity} places free (${percent(full(g))} full), ${distance(m)} from ${from.name}`,
    )
  const bikes = state.bikes
    .filter((b) => b.available > 0)
    .map((b) => ({ b, m: metres(b, from) }))
    .sort((a, b) => a.m - b.m)
    .slice(0, 8)
    .map(({ b, m }) => `- ${b.name} (${b.operator}): ${b.available} bikes, ${distance(m)} from ${from.name}`)
  return [
    `Ghent, Belgium. The state of the city at ${state.time} (UTC).`,
    CIRCULATION,
    `Sectors inside the R40: ${state.sectors.join(", ")} (the first is the car-free core).`,
    `Parking garages, nearest to ${from.name} first:`,
    ...garages,
    `Shared-bike stations with bikes, nearest to ${from.name} first:`,
    ...(bikes.length > 0 ? bikes : ["- none"]),
    ...(state.notice == null ? [] : [`About this data: ${state.notice}`]),
  ].join("\n")
}

function request(input: string, question: DecisionRequest["questions"][number]): DecisionRequest {
  return { model: DECISIONS_MODEL, input, questions: [question] }
}

export function planAsk(question: AskQuestion, state: StateWithNotice): AskPlan {
  const names = namesFor(state)
  const ask = formatAsk(question)
  const text = questionText(question, names)
  const belfry = { name: "the Belfry", ...ORIGIN }
  switch (question.template) {
    case "park": {
      const place = state.places.find((p) => p.slug === question.place)
      if (place == null) {
        throw new AskError(400, `Unknown place "${question.place}". Places: ${state.places.map((p) => p.slug).join(", ")}.`)
      }
      const at = { name: place.nl, lat: place.lat, lon: place.lon }
      // Only the garages inside the map are drawn, so a parking answer offers those;
      // a garage off the map is offered only when none on it has space, and says so.
      const withSpace = state.garages
        .filter((g) => g.available > 0)
        .map((g) => ({ g, m: metres(g, at) }))
        .sort((a, b) => a.m - b.m)
      const onMap = withSpace.filter(({ g }) => inArea(g))
      const garages = (onMap.length > 0 ? onMap : withSpace).slice(0, PARK_GARAGES)
      const bike = state.bikes
        .filter((b) => b.available > 0)
        .map((b) => ({ b, m: metres(b, at) }))
        .sort((a, b) => a.m - b.m)[0]
      const options: AskPlan["options"] = [
        ...garages.map(({ g, m }) => ({
          value: `garage:${g.slug}`,
          label: g.name,
          detail: `${g.available} of ${g.capacity} places free · ${distance(m)} away${inArea(g) ? "" : " · off the map"}`,
        })),
        ...(bike == null
          ? []
          : [
              {
                value: `bikes:${bike.b.operator}:${bike.b.id}`,
                label: "Shared bike",
                detail: `${bike.b.name}: ${bike.b.available} ${bike.b.available === 1 ? "bike" : "bikes"} · ${distance(bike.m)} away`,
              },
            ]),
      ]
      if (options.length === 0) {
        // Without bike data that is not "no bike has bikes": say what is missing.
        const bikesMissing = state.missing?.bikes
        if (bikesMissing != null) throw new AskError(503, `No garage has free places, and ${bikesMissing.charAt(0).toLowerCase()}${bikesMissing.slice(1)}`)
        throw new AskError(409, "No garage has free places and no bike station has bikes.")
      }
      return {
        ask,
        question: text,
        kind: "choice",
        options,
        detail: "",
        request: request(cityContext(state, at), {
          type: "choice",
          name: "park",
          instructions:
            `${text} I arrive by car now. Choose the best option: the garage that best combines a short walk to ` +
            `${place.nl} with enough free places, or, if no garage is close enough, leaving the car and taking a ` +
            `shared bike from the station named.`,
          choices: options.map((o) => ({ value: o.value, description: `${o.label}: ${o.detail}` })),
        }),
      }
    }
    case "drive": {
      const from = names.sector(question.from)
      const to = names.sector(question.to)
      const unknown = [from == null ? question.from : null, to == null ? question.to : null].filter((s) => s != null)
      if (unknown.length > 0) {
        throw new AskError(
          400,
          `Unknown sector "${unknown.join('", "')}". Sectors: ${state.sectors.map(slugify).join(", ")}.`,
        )
      }
      return {
        ask,
        question: text,
        kind: "predicate",
        options: [],
        detail: "From the circulation plan's sectors",
        request: request(cityContext(state, belfry), {
          type: "predicate",
          name: "drive",
          instructions:
            `Can a car drive from ${from} to ${to} without leaving the R40 ring road, that is, staying inside the ` +
            `area the R40 encloses the whole way, without going out onto the ring road itself?`,
        }),
      }
    }
    case "busy": {
      const centre = state.garages.filter((g) => metres(g, ORIGIN) <= CENTRE_RADIUS_M)
      // Judged from the centre's garages only: with none of them there is nothing to judge.
      if (centre.length === 0) {
        throw new AskError(503, `No garage within ${CENTRE_RADIUS_M / 1000} km of the Belfry is in the data: try again in a minute.`)
      }
      const capacity = centre.reduce((n, g) => n + g.capacity, 0)
      const taken = centre.reduce((n, g) => n + g.capacity - g.available, 0)
      return {
        ask,
        question: text,
        kind: "predicate",
        options: [],
        detail: `Centre garages ${percent(capacity > 0 ? taken / capacity : 0)} full`,
        request: request(cityContext(state, belfry), {
          type: "predicate",
          name: "busy",
          instructions:
            `Is the centre of Ghent busy right now? Judge from the parking garages within ${CENTRE_RADIUS_M / 1000} km ` +
            `of the Belfry: the centre is busy when most of them are more than 80% full, or several are full.`,
        }),
      }
    }
    case "q":
      return {
        ask,
        question: text,
        kind: "predicate",
        options: [],
        detail: "From the garages, bikes and sectors",
        request: request(cityContext(state, belfry), {
          type: "predicate",
          name: "question",
          instructions: `Answer this yes/no question about Ghent at the time above, from the city state given: ${text}`,
        }),
      }
  }
}

// "Ramen" does not say it is a garage; the headline does: "Park at the Ramen garage".
export function parkAt(garage: string): string {
  return `Park at ${/^the /i.test(garage) ? "" : "the "}${garage} garage`
}

// Reads the Decisions API's answer the way the panel shows it.
export function answerFrom(
  plan: AskPlan,
  response: DecisionResponse,
  meta: { source: AskAnswer["source"]; dataTime: string; ms: number; notice?: string },
): AskReply {
  const answer = response.answers[0]
  if (answer == null || answer.type === "refusal") throw new AskError(502, "The Decisions API declined to answer this question.")
  const base = { ask: plan.ask, question: plan.question, kind: plan.kind, ...meta }
  if (plan.kind === "choice" && answer.type === "choice") {
    const options = plan.options
      .map((o) => ({ ...o, probability: answer.probabilities.find((p) => p.value === o.value)?.probability ?? 0 }))
      .sort((a, b) => b.probability - a.probability)
    const chosen = options.find((o) => o.value === answer.choice)
    if (chosen == null) throw new AskError(502, "The Decisions API chose an option that was not offered.")
    const headline = chosen.value.startsWith("garage:") ? parkAt(chosen.label) : "Take a shared bike"
    return { ...base, answer: headline, probability: chosen.probability, detail: chosen.detail, sel: chosen.value, options }
  }
  if (plan.kind === "predicate" && answer.type === "predicate") {
    const yes = answer.probability >= 0.5
    return {
      ...base,
      answer: yes ? "Yes" : "No",
      probability: yes ? answer.probability : 1 - answer.probability,
      detail: plan.detail,
      sel: null,
      options: [],
    }
  }
  throw new AskError(502, `The Decisions API answered a ${answer.type}, not a ${plan.kind}.`)
}

export type Recordings = Record<string, { ask: string } & DecisionResponse>

export async function readRecordings(file: string = RECORDINGS_FILE): Promise<Recordings> {
  const text = await readFile(file, "utf8").catch(() => null)
  return text == null ? {} : (JSON.parse(text) as Recordings)
}

// Never pass the upstream body on: an error from the API can quote part of the key.
function upstreamError(error: unknown): AskError {
  if (error instanceof AskError) return error
  const status = /HTTP (\d{3})/.exec((error as Error).message)?.[1]
  return new AskError(502, status == null ? "Could not reach the Decisions API." : `The Decisions API answered HTTP ${status}.`)
}

// The reason a request's signal aborts with when its client hangs up: nobody is
// waiting for the answer any more.
const clientGone = () => new AskError(499, "The client stopped waiting.")

export type Deadline = {
  // Aborts when the deadline passes (an AskError 504) or the client goes (499).
  signal: AbortSignal
  // Milliseconds left.
  remaining(): number
  // Clears the timer; call it when the request is answered.
  done(): void
}

// A deadline `ms` from now, which also aborts when `outer` does (a client that went
// away).
export function startDeadline(ms: number, outer?: AbortSignal): Deadline {
  const controller = new AbortController()
  const end = performance.now() + ms
  const timer = setTimeout(() => controller.abort(new AskError(504, `No answer within ${ms / 1000} s. Try again in a moment.`)), ms)
  const onOuter = () => controller.abort(outer!.reason instanceof AskError ? outer!.reason : clientGone())
  if (outer?.aborted) onOuter()
  else outer?.addEventListener("abort", onOuter, { once: true })
  return {
    signal: controller.signal,
    remaining: () => Math.max(0, end - performance.now()),
    done: () => {
      clearTimeout(timer)
      outer?.removeEventListener("abort", onOuter)
    },
  }
}

// `work`, or the signal's reason as soon as it aborts, whichever comes first. The work
// itself goes on (a feed's request still fills its route's cache for the next question),
// and its failure is always handled here, so work nobody waits for any more never
// reports an unhandled rejection.
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {})
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    signal.addEventListener("abort", stop, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop)
        reject(error)
      },
    )
  })
}

// decide() in server/decisions.ts takes no AbortSignal, so a request that timed out
// would keep its connection open; this is the same live call, abortable.
export async function decideLive(
  request: DecisionRequest,
  options: { apiKey: string; signal: AbortSignal },
): Promise<DecisionResponse> {
  const res = await fetch(DECISIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: options.signal,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Decisions API answered HTTP ${res.status}`)
  return JSON.parse(text) as DecisionResponse
}

// A city state provider that may be given the request's signal (the live one gives
// each feed its own budget inside it); one that ignores it, like the fixture's, is
// still bounded by the deadline.
export type AskCityStateProvider = {
  current(options: { mode: "fixture" | "recorded" | "live"; time: string | null; signal?: AbortSignal }): Promise<LiveCityState>
}

export type AskOptions = {
  provider?: CityStateProvider | AskCityStateProvider
  // The key, read on each request so a server started without one can be given one.
  apiKey?: () => string | undefined
  recordingsFile?: string
  // The Decisions API client; tests pass a fake one. It must stop when `signal` aborts.
  decide?: (request: DecisionRequest, options: { apiKey: string; signal: AbortSignal }) => Promise<DecisionResponse>
  // The whole question's deadline (ASK_DEADLINE_MS), and the least time left for which
  // the Decisions request is still started (MIN_DECIDE_MS, at most a quarter of it).
  timeoutMs?: number
  minDecideMs?: number
  // The proxy hosts whose pages may ask (GHENT_LIVE_ALLOWED_HOSTS), read on each request.
  allowedHosts?: () => readonly string[]
}

// GHENT_LIVE_ALLOWED_HOSTS, parsed as vite.config.ts parses it.
export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "")
}

// application/json, with or without parameters ("; charset=utf-8"). A browser sends
// text/plain or a form cross-site without asking the server first; JSON it does not.
export function isJsonRequest(req: Pick<IncomingMessage, "headers">): boolean {
  return req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() === "application/json"
}

// A request from the app's own page: its Origin names the host it was sent to (Vite
// has checked that Host header before any route runs), or a proxy host named in
// GHENT_LIVE_ALLOWED_HOSTS (a leading "." allows its subdomains, as in Vite). No
// Origin at all is not a web page (curl, a script, the tests) and is let through;
// `Origin: null` (a sandboxed frame, a file) is foreign.
export function sameOriginOrAllowed(req: Pick<IncomingMessage, "headers">, allowedHosts: readonly string[]): boolean {
  const origin = req.headers.origin
  if (origin == null) return true
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.host !== "" && url.host === req.headers.host?.toLowerCase()) return true
  return allowedHosts.some((entry) => {
    const host = entry.toLowerCase()
    return host.startsWith(".") ? url.hostname === host.slice(1) || url.hostname.endsWith(host) : url.hostname === host
  })
}

// The parts of the city state each question cannot be answered without. A parking
// question offers garages (and a bike if there is data for one), "is the centre busy"
// is judged from the garages, and a free question can be about anything in the state,
// so it needs all of it. The circulation plan's sectors are always there (a constant).
type Part = "parking" | "bikes"
const NEEDS: Record<AskQuestion["template"], readonly Part[]> = {
  park: ["parking"],
  busy: ["parking"],
  drive: [],
  q: ["parking", "bikes"],
}
const PART_NAMES: Record<Part, string> = { parking: "the garages", bikes: "the bike stations" }

// The error for a question whose data is missing, naming why, or null when it has
// what it needs. It comes before any paid call, the cache and the recorded answers.
export function missingFor(question: AskQuestion, missing: LiveCityState["missing"]): AskError | null {
  const needs = NEEDS[question.template]
  const reasons = needs.flatMap((part) => (missing?.[part] == null ? [] : [missing[part]]))
  if (reasons.length === 0) return null
  const what = needs.map((part) => PART_NAMES[part]).join(" and ")
  return new AskError(503, `${reasons.join(" ")} This question needs ${what}: try again in a minute.`)
}

export function createAskRoute(
  options: AskOptions = {},
): Route & { ask(body: Partial<AskRequest>, options?: { signal?: AbortSignal }): Promise<AskReply> } {
  const provider: AskCityStateProvider = options.provider ?? fixtureCityState
  const apiKey = options.apiKey ?? (() => env.OPENAI_API_KEY)
  const allowedHosts = options.allowedHosts ?? (() => parseAllowedHosts(env.GHENT_LIVE_ALLOWED_HOSTS))
  const ask = options.decide ?? decideLive
  const deadlineMs = options.timeoutMs ?? ASK_DEADLINE_MS
  const minDecideMs = options.minDecideMs ?? Math.min(MIN_DECIDE_MS, deadlineMs / 4)
  const cache = new Map<string, { at: number; response: DecisionResponse }>()
  // One upstream call per question and data at a time: a shared view opened twice
  // before the first answer arrives waits for that answer instead of paying twice. The
  // call is aborted when the last request waiting for it has gone (its deadline
  // passed or its client hung up), so nobody pays for an answer nobody reads.
  type Inflight = { key: string; promise: Promise<DecisionResponse>; abort: AbortController; waiters: number }
  const inflight = new Map<string, Inflight>()
  let recordings: Promise<Recordings> | null = null

  function join(entry: Inflight, signal: AbortSignal): Promise<DecisionResponse> {
    entry.waiters++
    return new Promise<DecisionResponse>((resolve, reject) => {
      let settled = false
      const settle = (): boolean => {
        if (settled) return false
        settled = true
        entry.waiters--
        signal.removeEventListener("abort", leave)
        return true
      }
      function leave(): void {
        if (!settle()) return
        if (entry.waiters === 0) {
          entry.abort.abort(signal.reason)
          if (inflight.get(entry.key) === entry) inflight.delete(entry.key)
        }
        reject(signal.reason)
      }
      if (signal.aborted) return leave()
      signal.addEventListener("abort", leave, { once: true })
      entry.promise.then(
        (response) => {
          if (settle()) resolve(response)
        },
        (error: unknown) => {
          if (settle()) reject(error)
        },
      )
    })
  }

  // Answers within `deadline`, which started when the request arrived.
  async function answerWithin(body: Partial<AskRequest>, deadline: Deadline): Promise<AskReply> {
    const started = performance.now()
    const question = parseAsk(typeof body.ask === "string" ? body.ask : null)
    if (question == null) {
      throw new AskError(400, "Unknown question. Ask park:<place>, drive:<sector>~<sector>, busy:now or q:<a yes/no question>.")
    }
    const mode = body.mode === "recorded" || body.mode === "live" ? body.mode : "fixture"
    const time = typeof body.time === "string" && !Number.isNaN(Date.parse(body.time)) ? body.time : null
    // A live provider may add a `notice` to the state; CityState itself has none. It is
    // given the deadline's signal and waited for no longer than the deadline.
    let state: LiveCityState
    try {
      // A request that is already over (its client went) does not read the city at all.
      if (deadline.signal.aborted) throw deadline.signal.reason
      state = await untilAborted(provider.current({ mode, time, signal: deadline.signal }), deadline.signal)
    } catch (error) {
      if (error instanceof AskError) throw error
      // Any other error's message may name a file or host; only a CityStateError's is passed on.
      throw new AskError(502, error instanceof CityStateError ? error.message : "Could not read the city's data.")
    }
    const missing = missingFor(question, state.missing)
    if (missing != null) throw missing
    const plan = planAsk(question, state)
    const key = recordingKey(plan.request)
    const notice = state.notice
    const meta = (source: AskAnswer["source"]) => ({
      source,
      dataTime: state.time,
      ms: Math.round(performance.now() - started),
      ...(notice == null ? {} : { notice }),
    })

    const hit = cache.get(key)
    if (hit != null && Date.now() - hit.at < CACHE_TTL_MS) return answerFrom(plan, hit.response, meta("cached"))

    const secret = apiKey()
    if (secret == null || secret === "") {
      recordings ??= readRecordings(options.recordingsFile)
      // Within the deadline too; the shared read goes on for the requests after this one.
      const all = await untilAborted(recordings, deadline.signal)
      const recorded = Object.hasOwn(all, key) ? all[key] : undefined
      if (recorded == null) {
        throw new AskError(
          503,
          "No recorded answer for this question on this data, and the server has no OPENAI_API_KEY to ask the Decisions API.",
        )
      }
      return answerFrom(plan, recorded, meta("recorded"))
    }
    let entry = inflight.get(key)
    if (entry == null) {
      // A paid request starts only for a client still waiting, with time to answer.
      if (deadline.signal.aborted) throw deadline.signal.reason
      if (deadline.remaining() < minDecideMs) {
        throw new AskError(504, "No answer in time: reading the city's data took too long. Try again in a moment.")
      }
      const abort = new AbortController()
      const promise: Promise<DecisionResponse> = ask(plan.request, { apiKey: secret, signal: abort.signal })
        .then((response) => {
          // Only an answer the panel can show is kept; a refusal is asked again next time.
          answerFrom(plan, response, meta("live"))
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
          cache.set(key, { at: Date.now(), response: { model: response.model, answers: response.answers } })
          return response
        })
        .finally(() => {
          if (inflight.get(key)?.promise === promise) inflight.delete(key)
        })
      // Every waiter handles the outcome; this keeps a call nobody waits for any more
      // from reporting an unhandled rejection.
      promise.catch(() => {})
      entry = { key, promise, abort, waiters: 0 }
      inflight.set(key, entry)
    }
    let response: DecisionResponse
    try {
      response = await join(entry, deadline.signal)
    } catch (error) {
      throw upstreamError(error)
    }
    return answerFrom(plan, response, meta("live"))
  }

  // A question asked directly (the tests, the --record path) gets its own deadline.
  async function answer(body: Partial<AskRequest>, opts: { signal?: AbortSignal } = {}): Promise<AskReply> {
    const deadline = startDeadline(deadlineMs, opts.signal)
    try {
      return await answerWithin(body, deadline)
    } finally {
      deadline.done()
    }
  }

  return {
    method: "POST",
    path: "/api/ask",
    ask: answer,
    async handle(req, res) {
      // Both checks come before the body is read: a refused request costs nothing.
      if (!isJsonRequest(req)) {
        const failure: AskFailure = { ask: "", question: null, error: "Send the question as JSON (Content-Type: application/json)." }
        return sendJson(res, 415, failure)
      }
      if (!sameOriginOrAllowed(req, allowedHosts())) {
        const failure: AskFailure = { ask: "", question: null, error: "Only the app's own page can ask." }
        return sendJson(res, 403, failure)
      }
      // The deadline starts now and covers reading the body, the city's data and the
      // Decisions call; a client that hangs up ends it too (the response then closes
      // before it is finished).
      const gone = new AbortController()
      res.once("close", () => {
        if (!res.writableFinished) gone.abort(clientGone())
      })
      const deadline = startDeadline(deadlineMs, gone.signal)
      const reply = (status: number, payload: unknown): void => {
        if (!gone.signal.aborted && !res.destroyed) sendJson(res, status, payload)
      }
      try {
        let body: Partial<AskRequest>
        try {
          const parsed = await untilAborted(readJson<unknown>(req, 4 * 1024), deadline.signal)
          if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
          body = parsed as Partial<AskRequest>
        } catch (error) {
          if (error instanceof AskError) return reply(error.status, { ask: "", question: null, error: error.message } satisfies AskFailure)
          const failure: AskFailure = { ask: "", question: null, error: 'Send JSON like {"ask": "park:gravensteen"}.' }
          return reply(400, failure)
        }
        try {
          reply(200, await answerWithin(body, deadline))
        } catch (error) {
          const failed = upstreamError(error)
          const question = parseAsk(typeof body.ask === "string" ? body.ask : null)
          const failure: AskFailure = {
            ask: question == null ? "" : formatAsk(question),
            question: question == null ? null : questionText(question),
            error: failed.message,
          }
          reply(failed.status, failure)
        }
      } finally {
        deadline.done()
      }
    },
  }
}

// Fixture mode answers from T7's fixture city state (so the committed recordings keep
// answering offline); live and recorded mode from the live one (server/city-state-live.ts).
export default createAskRoute({ provider: modeCityState })

// node server/routes/ask.ts --record <ask> [<ask> …]: ask the Decisions API each
// question on the fixture city state and write the answers, all in one file. It
// always uses the fixture state, whatever the default route reads.
async function record(asks: string[]): Promise<void> {
  const secret = env.OPENAI_API_KEY
  if (secret == null || secret === "") throw new Error("OPENAI_API_KEY is not set")
  const state = await fixtureCityState.current({ mode: "fixture", time: null })
  const recordings: Recordings = {}
  for (const raw of asks) {
    const question = parseAsk(raw)
    if (question == null) throw new Error(`not a question: ${raw}`)
    const plan = planAsk(question, state)
    const started = performance.now()
    const response = await decide(plan.request, { apiKey: secret })
    const shown = answerFrom(plan, response, { source: "live", dataTime: state.time, ms: 0 })
    const ms = Math.round(performance.now() - started)
    console.log(`${plan.ask}  ${shown.answer} ${percent(shown.probability)}  (${ms} ms)`)
    recordings[recordingKey(plan.request)] = { ask: plan.ask, model: response.model, answers: response.answers }
  }
  const sorted = Object.fromEntries(Object.entries(recordings).sort(([, a], [, b]) => a.ask.localeCompare(b.ask)))
  await writeFile(RECORDINGS_FILE, JSON.stringify(sorted, null, 2) + "\n")
  console.log(`wrote ${Object.keys(sorted).length} answers to server/ask-recordings.json`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args[0] !== "--record" || args.length < 2) {
    console.error("usage: node server/routes/ask.ts --record <ask> [<ask> …]")
    process.exitCode = 2
  } else {
    await record(args.slice(1)).catch((error: unknown) => {
      console.error((error as Error).message)
      process.exitCode = 1
    })
  }
}
