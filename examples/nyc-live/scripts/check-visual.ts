// Ask the Decisions API whether a screenshot shows what a ticket promises.
//
//   pnpm check:visual shots/venue.png checks/venue.json
//   pnpm check:visual shots/venue.png checks/venue.json --record   # also save the answers
//   pnpm check:visual shots/venue.png checks/venue.json --replay   # no key: use saved answers
//
// A check file is { "context": "...", "checks": [...] }; see checks/venue.json and
// the Check type in server/decisions.ts. Exits 0 when every check passes, 1 when
// one fails, 2 when the checks could not run.

import { readFileSync } from "node:fs"
import process, { env, exit } from "node:process"
import { parseArgs } from "node:util"
import { DECISIONS_MODEL, decide, evaluate, toQuestion, type Check } from "../server/decisions.ts"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    record: { type: "boolean", default: false },
    replay: { type: "boolean", default: false },
    recordings: { type: "string", default: "test/recordings" },
    "env-file": { type: "string" },
  },
})

const [pngPath, specPath] = positionals
if (pngPath == null || specPath == null) {
  console.error("usage: pnpm check:visual <screenshot.png> <checks.json> [--record | --replay] [--env-file <path>]")
  exit(2)
}
if (values["env-file"] != null) process.loadEnvFile(values["env-file"])

const spec = JSON.parse(readFileSync(specPath, "utf8")) as { context: string; checks: Check[] }
const image = `data:image/png;base64,${readFileSync(pngPath).toString("base64")}`
const mode = values.replay ? "replay" : values.record ? "record" : null

try {
  const response = await decide(
    {
      model: DECISIONS_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: spec.context },
            { type: "input_image", image_url: image },
          ],
        },
      ],
      questions: spec.checks.map(toQuestion),
    },
    { apiKey: env.OPENAI_API_KEY, recording: mode == null ? undefined : { dir: values.recordings, mode } },
  )
  const results = evaluate(spec.checks, response.answers)
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(24)} ${r.detail}`)
  exit(results.every((r) => r.pass) ? 0 : 1)
} catch (error) {
  console.error(`check:visual could not run: ${(error as Error).message}`)
  exit(2)
}
