// Ask the OpenAI Decisions API whether overlay screenshots match the design
// reference, with every reference and every screenshot in one request.
//
//   node test/design-check.ts test/checks/t10.json --reference launcher=<png> --reference panel=<png>
//   ... --record                # also save the answers under test/recordings/
//   node test/design-check.ts test/checks/t10.json --replay   # no key, no references
//
// The reference screenshots are not in the repository. The check file names each
// reference with the sha256 it was written against, and a recording is keyed by
// the request with every image replaced by its sha256, so --replay needs neither
// the references nor a key. Exits 0 when every check passes, 1 when one fails,
// 2 when the checks could not run.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process, { env, exit } from "node:process"
import { parseArgs } from "node:util"

const DECISIONS_URL = "https://api.openai.com/v1/decisions"
const DECISIONS_MODEL = env.DECISIONS_MODEL ?? "gpt-6-luna"

type Check =
  | { type: "predicate"; name: string; instructions: string; min: number }
  | { type: "score"; name: string; instructions: string; levels: Array<{ label: string }>; minLevel: string }

type Spec = {
  context: string
  references: Array<{ name: string; caption: string; sha256: string }>
  shots: Array<{ name: string; caption: string; path: string }>
  checks: Check[]
}

type Answer =
  | { type: "predicate"; name: string | null; probability: number }
  | { type: "score"; name: string | null; probabilities: Array<{ label: string; probability: number }> }
  | { type: "refusal" | "choice"; name: string | null }

type Part = { type: "input_text"; text: string } | { type: "input_image"; image_url: string }

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex")

// References first, then shots, each after its caption. `image` returns the
// image_url for one image: the real data URL, or its hash for the recording key.
function buildRequest(spec: Spec, image: (args: { kind: "reference" | "shot"; name: string }) => string) {
  const content: Part[] = [{ type: "input_text", text: spec.context }]
  for (const ref of spec.references) {
    content.push({ type: "input_text", text: ref.caption }, { type: "input_image", image_url: image({ kind: "reference", name: ref.name }) })
  }
  for (const shot of spec.shots) {
    content.push({ type: "input_text", text: shot.caption }, { type: "input_image", image_url: image({ kind: "shot", name: shot.name }) })
  }
  return {
    model: DECISIONS_MODEL,
    input: [{ role: "user" as const, content }],
    questions: spec.checks.map((check) =>
      check.type === "predicate"
        ? { type: check.type, name: check.name, instructions: check.instructions }
        : { type: check.type, name: check.name, instructions: check.instructions, levels: check.levels },
    ),
  }
}

function recordingKey(spec: Spec, shotHashes: Map<string, string>): string {
  const keyed = buildRequest(spec, ({ kind, name }) =>
    kind === "reference"
      ? `sha256:${spec.references.find((ref) => ref.name === name)?.sha256 ?? "?"}`
      : `sha256:${shotHashes.get(name) ?? "?"}`,
  )
  return sha256(JSON.stringify(keyed)).slice(0, 16)
}

const pct = (p: number) => `${Math.round(p * 100)}%`

// Answers come back in question order; a refusal or a missing answer fails its check.
function evaluate(checks: Check[], answers: Answer[]): Array<{ name: string; pass: boolean; detail: string }> {
  return checks.map((check, index) => {
    const answer = answers[index]
    if (check.type === "predicate" && answer?.type === "predicate") {
      return { name: check.name, pass: answer.probability >= check.min, detail: `p=${pct(answer.probability)} (needs ${pct(check.min)})` }
    }
    if (check.type === "score" && answer?.type === "score") {
      const best = [...answer.probabilities].sort((a, b) => b.probability - a.probability)[0]
      const got = check.levels.findIndex((level) => level.label === best?.label)
      const need = check.levels.findIndex((level) => level.label === check.minLevel)
      return {
        name: check.name,
        pass: got >= 0 && need >= 0 && got >= need,
        detail: `${best?.label ?? "?"} at ${pct(best?.probability ?? 0)} (needs ${check.minLevel} or better)`,
      }
    }
    return { name: check.name, pass: false, detail: `no ${check.type} answer (${answer?.type ?? "missing"})` }
  })
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      reference: { type: "string", multiple: true, default: [] },
      record: { type: "boolean", default: false },
      replay: { type: "boolean", default: false },
      recordings: { type: "string", default: "test/recordings" },
      "env-file": { type: "string" },
    },
  })
  const specPath = positionals[0]
  if (specPath == null) {
    console.error("usage: node test/design-check.ts <checks.json> --reference <name>=<png>... [--record | --replay] [--env-file <path>]")
    return 2
  }
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec
  const shots = new Map(spec.shots.map((shot) => [shot.name, readFileSync(shot.path)]))
  const shotHashes = new Map([...shots].map(([name, png]) => [name, sha256(png)]))
  const file = join(values.recordings, `${recordingKey(spec, shotHashes)}.json`)

  let answers: Answer[]
  if (values.replay) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      console.error(`design-check could not run: no recorded answer at ${file}; run once with a key and --record`)
      return 2
    }
    answers = (JSON.parse(text) as { answers: Answer[] }).answers
  } else {
    const references = new Map<string, Buffer>()
    for (const pair of values.reference) {
      const at = pair.indexOf("=")
      references.set(pair.slice(0, at), readFileSync(pair.slice(at + 1)))
    }
    for (const ref of spec.references) {
      const png = references.get(ref.name)
      if (png == null) {
        console.error(`design-check could not run: pass --reference ${ref.name}=<png>`)
        return 2
      }
      if (sha256(png) !== ref.sha256) {
        console.error(`design-check could not run: reference ${ref.name} is not the one ${specPath} was written against`)
        return 2
      }
    }
    if (values["env-file"] != null) {
      process.loadEnvFile(values["env-file"])
    }
    const apiKey = env.OPENAI_API_KEY
    if (apiKey == null || apiKey === "") {
      console.error("design-check could not run: OPENAI_API_KEY is not set (or pass --replay)")
      return 2
    }
    const dataUrl = (png: Buffer | undefined) => `data:image/png;base64,${png?.toString("base64") ?? ""}`
    const request = buildRequest(spec, ({ kind, name }) => dataUrl(kind === "reference" ? references.get(name) : shots.get(name)))
    const response = await fetch(DECISIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
    })
    const text = await response.text()
    if (!response.ok) {
      console.error(`design-check could not run: Decisions API answered HTTP ${response.status}: ${text.slice(0, 300)}`)
      return 2
    }
    const parsed = JSON.parse(text) as { model: string; answers: Answer[] }
    answers = parsed.answers
    if (values.record) {
      mkdirSync(values.recordings, { recursive: true })
      writeFileSync(file, `${JSON.stringify({ model: parsed.model, answers }, null, 2)}\n`)
    }
  }
  const results = evaluate(spec.checks, answers)
  for (const result of results) {
    console.log(`${result.pass ? "PASS" : "FAIL"}  ${result.name.padEnd(24)} ${result.detail}`)
  }
  return results.every((result) => result.pass) ? 0 : 1
}

exit(await main())
