// Download the Lichtplan from Stad Gent open data and write the fixture the Lichtplan
// layer draws (ticket T4 in plan/PLAN.md):
//
//   node scripts/fetch-lichtplan.ts             # reuses data/lichtplan/*.geojson when present
//   node scripts/fetch-lichtplan.ts --refresh   # downloads again
//
// Two datasets, both GeoJSON exports of the Explore API v2.1, no key needed:
// points-of-interest-poi-lichtplan-gent (the lit places: towers, bridges, facades,
// streets) and route-lichtplan-gent (the Lichtplan walk, its extensions and
// shortcuts). The raw answers go to data/lichtplan/ (ignored); public/fixtures/
// lichtplan.json gets the points inside AREA and the lines clipped to it, in scene
// metres rounded to 0.1 m. The Lichtplan does not change from minute to minute, so
// the fixture covers the whole area and every data mode draws it.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import {
  chooseLitPoints,
  clipToArea,
  encodeFile,
  linesFromGeoJson,
  pointsFromGeoJson,
  poiKind,
  type LichtplanData,
} from "../src/layers/lichtplan.ts"

const API = "https://data.stad.gent/api/explore/v2.1/catalog/datasets"
const DATASETS = { points: "points-of-interest-poi-lichtplan-gent", route: "route-lichtplan-gent" } as const
const RAW_DIR = "data/lichtplan"
const OUT = "public/fixtures/lichtplan.json"
const MAX_FIXTURE_BYTES = 300 * 1024
// What the datasets held when this was written; a different count is reported, not fatal.
const EXPECTED = { points: 67, lines: 7 }

type Feature = { type: "Feature"; geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> | null }

const { values } = parseArgs({ options: { refresh: { type: "boolean", default: false } } })

async function download(dataset: string): Promise<Feature[]> {
  const res = await fetch(`${API}/${dataset}/exports/geojson`, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`${dataset}: HTTP ${res.status}`)
  const body = (await res.json()) as { type?: string; features?: Feature[] }
  if (body.type !== "FeatureCollection" || !Array.isArray(body.features)) throw new Error(`${dataset}: not a FeatureCollection`)
  return body.features
}

async function features(dataset: string): Promise<Feature[]> {
  const path = `${RAW_DIR}/${dataset}.geojson`
  if (!values.refresh && existsSync(path)) {
    const body = JSON.parse(readFileSync(path, "utf8")) as { features?: Feature[] }
    if (Array.isArray(body.features)) return body.features
  }
  const list = await download(dataset)
  mkdirSync(RAW_DIR, { recursive: true })
  writeFileSync(path, JSON.stringify({ type: "FeatureCollection", features: list }))
  return list
}

const rawPoints = await features(DATASETS.points)
const rawLines = await features(DATASETS.route)
for (const [what, list, expected] of [
  ["points", rawPoints, EXPECTED.points],
  ["lines", rawLines, EXPECTED.lines],
] as const) {
  const note = list.length === expected ? "" : ` (expected ${expected}: the dataset changed)`
  console.log(`${what.padEnd(7)} ${list.length} features${note}`)
}

const all: LichtplanData = { points: pointsFromGeoJson(rawPoints), lines: linesFromGeoJson(rawLines) }
const data = clipToArea(all)
console.log(`kept    ${data.points.length} points inside AREA, ${data.lines.length} pieces of the walk (${all.lines.length} distinct lines)`)

// The Street-level view looks at the three towers, and the walk crosses the Leie on
// the Sint-Michielsbrug: all four must be in the fixture, and the towers lit.
const lit = chooseLitPoints(data.points)
const probes: Array<{ what: string; match: RegExp; lit: boolean }> = [
  { what: "the Belfry", match: /^Belfort/, lit: true },
  { what: "St Bavo's Cathedral", match: /^Sint-Baafskathedraal/, lit: true },
  { what: "St Nicholas' Church", match: /^Sint-Niklaaskerk/, lit: true },
  { what: "the Sint-Michielsbrug", match: /^Sint-Michielsbrug/, lit: true },
]
for (const probe of probes) {
  const point = data.points.find((p) => probe.match.test(p.nl))
  const ok = point != null && (!probe.lit || lit.some((l) => l.id === point.id))
  console.log(`${ok ? "ok     " : "MISSING"} ${probe.what}${point == null ? "" : ` (poi:${point.id})`}`)
  if (!ok) process.exitCode = 1
}
console.log(`lit     ${lit.map((p) => `${p.nl} (${poiKind(p)})`).join(", ")}`)

const file = encodeFile(data, "Stad Gent open data: points-of-interest-poi-lichtplan-gent, route-lichtplan-gent; Modellicentie Gratis Hergebruik")
// One point or line per line, so a later refresh diffs readably.
const text =
  `{"source":${JSON.stringify(file.source)},\n` +
  `"points":[\n${file.points.map((p) => JSON.stringify(p)).join(",\n")}],\n` +
  `"lines":[\n${file.lines.map((l) => JSON.stringify(l)).join(",\n")}]}\n`
mkdirSync("public/fixtures", { recursive: true })
writeFileSync(OUT, text)
const bytes = statSync(OUT).size
console.log(`${OUT}: ${(bytes / 1024).toFixed(0)} KB`)
if (bytes > MAX_FIXTURE_BYTES) {
  console.error(`the fixture is over ${MAX_FIXTURE_BYTES / 1024} KB`)
  process.exitCode = 1
}
