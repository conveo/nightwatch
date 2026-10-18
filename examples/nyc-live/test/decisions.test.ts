import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { decide, evaluate, recordingKey, toQuestion, type Answer, type Check, type DecisionRequest } from "../server/decisions.ts"

const checks: Check[] = [
  { type: "predicate", name: "pin", instructions: "A red pin is visible.", min: 0.8 },
  {
    type: "choice",
    name: "tab",
    instructions: "Which tab is selected?",
    choices: [{ value: "Roster" }, { value: "Plans" }],
    expect: "Roster",
  },
  {
    type: "score",
    name: "readable",
    instructions: "How readable is the text?",
    levels: [{ label: "poor" }, { label: "acceptable" }, { label: "good" }],
    minLevel: "acceptable",
  },
]

// The answer shapes below are copied from a real Decisions API response.
const answers: Answer[] = [
  { type: "predicate", name: "pin", probability: 0.93 },
  {
    type: "choice",
    name: "tab",
    choice: "Roster",
    probabilities: [
      { value: "Roster", probability: 1 },
      { value: "Plans", probability: 0 },
    ],
    confidence: 1,
  },
  {
    type: "score",
    name: "readable",
    score: 0.03,
    probabilities: [
      { value: 0, label: "poor", probability: 0.97 },
      { value: 1, label: "acceptable", probability: 0.03 },
      { value: 2, label: "good", probability: 0 },
    ],
    confidence: 0.96,
  },
]

test("each check type passes or fails on its own bar", () => {
  const results = evaluate(checks, answers)
  assert.deepEqual(
    results.map((r) => [r.name, r.pass]),
    [
      ["pin", true],
      ["tab", true],
      ["readable", false],
    ],
  )
  assert.match(results[2]!.detail, /poor at 97%/)
})

test("a refusal or a missing answer fails its check", () => {
  const results = evaluate(checks, [{ type: "refusal", name: "pin" }])
  assert.deepEqual(
    results.map((r) => r.pass),
    [false, false, false],
  )
})

test("a choice must be the expected one and clear its bar", () => {
  const strict: Check = { ...(checks[1] as Extract<Check, { type: "choice" }>), min: 0.99 }
  const lukewarm: Answer = {
    type: "choice",
    name: "tab",
    choice: "Roster",
    probabilities: [
      { value: "Roster", probability: 0.6 },
      { value: "Plans", probability: 0.4 },
    ],
    confidence: 0.2,
  }
  assert.equal(evaluate([strict], [lukewarm])[0]!.pass, false)
})

test("questions sent to the API carry no thresholds", () => {
  assert.deepEqual(toQuestion(checks[0]!), { type: "predicate", name: "pin", instructions: "A red pin is visible." })
  assert.equal("minLevel" in toQuestion(checks[2]!), false)
})

test("replay reads a recorded answer and never needs a key", async () => {
  const request: DecisionRequest = { model: "gpt-6-luna", input: "hello", questions: checks.map(toQuestion) }
  const dir = mkdtempSync(join(tmpdir(), "nyc-live-recordings-"))
  await assert.rejects(decide(request, { recording: { dir, mode: "replay" } }), /no recorded answer/)
  writeFileSync(join(dir, `${recordingKey(request)}.json`), JSON.stringify({ model: "gpt-6-luna", answers }))
  const response = await decide(request, { apiKey: "", recording: { dir, mode: "replay" } })
  assert.equal(response.answers.length, 3)
})

test("the recording key is stable for one request and changes with it", () => {
  const a: DecisionRequest = { model: "gpt-6-luna", input: "x", questions: [toQuestion(checks[0]!)] }
  assert.equal(recordingKey(a), recordingKey(structuredClone(a)))
  assert.notEqual(recordingKey(a), recordingKey({ ...a, input: "y" }))
})
