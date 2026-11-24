import type { DataMode } from "../view-state.ts"

// The wire contract between the panel and POST /api/ask (server/routes/ask.ts).

export type AskTemplate = "route" | "line" | "yesno"

// One question: a template and its one parameter, plus the view's data mode and
// time, which pick the city state it is answered from.
export type AskQuestion =
  | { template: "route"; place: string }
  | { template: "line"; line: string }
  | { template: "yesno"; question: string }

export type AskRequest = AskQuestion & { mode?: DataMode; t?: string | null }

export type AskResponse = {
  template: AskTemplate
  // The question as the panel shows it.
  question: string
  // The most likely answer ("6 train", "Yes", "No") and its probability, or null
  // when the model declined to answer.
  answer: string | null
  probability: number | null
  // Every option with its probability, most likely first.
  options: Array<{ value: string; probability: number }>
  // What the scene could highlight for this answer: "line:6", "line:R/W",
  // "citibike" or "walk".
  highlight: string | null
  state: { source: DataMode; time: string }
  ms: number
  cached: boolean
}

// GET /api/ask: what the panel can offer for the current city state.
export type AskOptions = {
  places: Array<{ id: string; name: string }>
  lines: Array<{ id: string; color: string; status: string }>
  state: { source: DataMode; time: string }
}

export const YESNO_MAX_LENGTH = 200
