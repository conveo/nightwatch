// A small client for the OpenAI Decisions API (POST /v1/decisions): typed questions
// about text or images, answered with probabilities instead of generated text.
// Node only: the API key must never reach the browser.
//
// Recorded answers make checks repeatable without a key: --record saves each
// response under a hash of the request, --replay reads it back (tests, CI).

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { env } from "node:process"

export const DECISIONS_URL = env.NYC_LIVE_DECISIONS_URL ?? "https://api.openai.com/v1/decisions"
export const DECISIONS_MODEL = env.NYC_LIVE_DECISIONS_MODEL ?? "gpt-6-luna"

export type Question =
  | { type: "predicate"; name: string; instructions: string }
  | {
      type: "choice"
      name: string
      instructions: string
      choices: Array<{ value: string | boolean; description?: string }>
    }
  | { type: "score"; name: string; instructions: string; levels: Array<{ label: string; description?: string }> }

export type Answer =
  | { type: "predicate"; name: string | null; probability: number }
  | {
      type: "choice"
      name: string | null
      choice: string | boolean
      probabilities: Array<{ value: string | boolean; probability: number }>
      confidence: number
    }
  | {
      type: "score"
      name: string | null
      score: number
      probabilities: Array<{ value: number; label: string; probability: number }>
      confidence: number
    }
  | { type: "refusal"; name: string | null }

export type InputPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string }

export type DecisionRequest = {
  model: string
  input: string | Array<{ role: "user"; content: InputPart[] }>
  questions: Question[]
}

export type DecisionResponse = { model: string; answers: Answer[]; usage?: unknown }

export type Recording = { dir: string; mode: "record" | "replay" }

export function recordingKey(request: DecisionRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 16)
}

export async function decide(
  request: DecisionRequest,
  options: { apiKey?: string; recording?: Recording } = {},
): Promise<DecisionResponse> {
  const file = options.recording == null ? null : join(options.recording.dir, `${recordingKey(request)}.json`)
  if (options.recording?.mode === "replay") {
    const text = await readFile(file!, "utf8").catch(() => null)
    if (text == null) throw new Error(`no recorded answer at ${file}; run once with a key and --record`)
    return JSON.parse(text) as DecisionResponse
  }
  const apiKey = options.apiKey ?? env.OPENAI_API_KEY
  if (apiKey == null || apiKey === "") throw new Error("OPENAI_API_KEY is not set (or pass --replay)")
  const res = await fetch(DECISIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Decisions API answered HTTP ${res.status}: ${text.slice(0, 300)}`)
  const response = JSON.parse(text) as DecisionResponse
  if (file != null) {
    await mkdir(options.recording!.dir, { recursive: true })
    await writeFile(file, JSON.stringify({ model: response.model, answers: response.answers }, null, 2) + "\n")
  }
  return response
}

// A check is a question plus the bar its answer must clear.
export type Check =
  | { type: "predicate"; name: string; instructions: string; min: number }
  | {
      type: "choice"
      name: string
      instructions: string
      choices: Array<{ value: string | boolean; description?: string }>
      expect: string | boolean
      min?: number
    }
  | {
      type: "score"
      name: string
      instructions: string
      levels: Array<{ label: string; description?: string }>
      minLevel: string
    }

export type CheckResult = { name: string; pass: boolean; detail: string }

export function toQuestion(check: Check): Question {
  switch (check.type) {
    case "predicate":
      return { type: "predicate", name: check.name, instructions: check.instructions }
    case "choice":
      return { type: "choice", name: check.name, instructions: check.instructions, choices: check.choices }
    case "score":
      return { type: "score", name: check.name, instructions: check.instructions, levels: check.levels }
  }
}

const pct = (p: number) => `${Math.round(p * 100)}%`

// Answers come back in question order; a refusal or a missing answer fails its check.
export function evaluate(checks: Check[], answers: Answer[]): CheckResult[] {
  return checks.map((check, i) => {
    const answer = answers[i]
    if (answer == null || answer.type === "refusal" || answer.type !== check.type) {
      return { name: check.name, pass: false, detail: `no ${check.type} answer (${answer?.type ?? "missing"})` }
    }
    if (check.type === "predicate" && answer.type === "predicate") {
      return {
        name: check.name,
        pass: answer.probability >= check.min,
        detail: `p=${pct(answer.probability)} (needs ${pct(check.min)})`,
      }
    }
    if (check.type === "choice" && answer.type === "choice") {
      const min = check.min ?? 0.5
      const p = answer.probabilities.find((c) => c.value === check.expect)?.probability ?? 0
      return {
        name: check.name,
        pass: answer.choice === check.expect && p >= min,
        detail: `chose ${String(answer.choice)}; ${String(check.expect)} at ${pct(p)} (needs ${pct(min)})`,
      }
    }
    if (check.type === "score" && answer.type === "score") {
      const best = [...answer.probabilities].sort((a, b) => b.probability - a.probability)[0]
      const got = check.levels.findIndex((l) => l.label === best?.label)
      const need = check.levels.findIndex((l) => l.label === check.minLevel)
      return {
        name: check.name,
        pass: got >= 0 && need >= 0 && got >= need,
        detail: `${best?.label ?? "?"} at ${pct(best?.probability ?? 0)} (needs ${check.minLevel} or better)`,
      }
    }
    return { name: check.name, pass: false, detail: "unexpected answer" }
  })
}
