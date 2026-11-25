// Download the circulation plan from Stad Gent open data and write the fixture the
// circulation layer draws (ticket T3 in plan/PLAN.md):
//
//   node scripts/fetch-circulation.ts             # reuses data/circulation/*.json when present
//   node scripts/fetch-circulation.ts --refresh   # downloads again
//
// Two datasets, no key needed: sectoren-circulatieplan-gent (the six sectors, the
// car-free pieces and the pedestrian streets) and knips-circulatieplan-gent (the
// "knips", short lines where cars cannot cross). The raw answers go to
// data/circulation/ (ignored); public/fixtures/circulation.json gets every zone
// clipped to AREA and simplified, and every knip inside AREA, in scene metres rounded
// to 0.1 m. The plan does not change from minute to minute, so the fixture covers
// the whole area and every data mode draws it.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import {
  SECTORS,
  areaRect,
  classifySectorFeatures,
  clipPolygon,
  colourSectors,
  encodePoints,
  findNeighbours,
  knipKind,
  linesFromGeometry,
  parseCirculationFile,
  polygonArea,
  polygonsFromGeometry,
  simplifyRing,
  slugify,
  zoneAt,
  type CirculationFile,
  type Polygon,
  type SourceFeature,
  type XZ,
  type ZoneKind,
} from "../src/layers/circulation.ts"

const API = "https://data.stad.gent/api/explore/v2.1/catalog/datasets"
const DATASETS = { sectors: "sectoren-circulatieplan-gent", knips: "knips-circulatieplan-gent" } as const
const RAW_DIR = "data/circulation"
const OUT = "public/fixtures/circulation.json"
const MAX_FIXTURE_BYTES = 300 * 1024
// Simplification tolerance (m) and the smallest piece kept (m²), per kind of zone.
const KEEP: Record<ZoneKind, { tolerance: number; minArea: number }> = {
  sector: { tolerance: 1.5, minArea: 200 },
  "car-free": { tolerance: 0.5, minArea: 20 },
  pedestrian: { tolerance: 0.5, minArea: 20 },
}

const { values } = parseArgs({ options: { refresh: { type: "boolean", default: false } } })

async function download(dataset: string): Promise<SourceFeature[]> {
  const res = await fetch(`${API}/${dataset}/exports/geojson`, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`${dataset}: HTTP ${res.status}`)
  const body = (await res.json()) as { type?: string; features?: SourceFeature[] }
  if (body.type !== "FeatureCollection" || !Array.isArray(body.features)) throw new Error(`${dataset}: not a FeatureCollection`)
  return body.features
}

async function features(name: keyof typeof DATASETS): Promise<SourceFeature[]> {
  const path = `${RAW_DIR}/${name}.json`
  if (!values.refresh && existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as SourceFeature[]
  const list = await download(DATASETS[name])
  mkdirSync(RAW_DIR, { recursive: true })
  writeFileSync(path, JSON.stringify(list))
  return list
}

const rect = areaRect()
const inArea = ([x, z]: XZ) => x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ

// Zones: one entry per name and kind, each piece clipped and simplified.
const { zones: sourceZones, skipped } = classifySectorFeatures(await features("sectors"))
const zones = new Map<string, { name: string; kind: ZoneKind; polygons: Polygon[] }>()
let dropped = 0
for (const zone of sourceZones) {
  const keep = KEEP[zone.kind]
  for (const polygon of polygonsFromGeometry(zone.geometry)) {
    const clipped = clipPolygon(polygon, rect)
    const simple = clipped?.map((ring) => simplifyRing(ring, keep.tolerance)).filter((ring) => ring.length >= 3)
    if (simple == null || simple.length === 0 || polygonArea(simple) < keep.minArea) {
      dropped++
      continue
    }
    const key = `${zone.kind}:${zone.name}`
    const entry = zones.get(key) ?? { name: zone.name, kind: zone.kind, polygons: [] }
    entry.polygons.push(simple)
    zones.set(key, entry)
  }
}
console.log(`sectors  ${sourceZones.length + skipped} records: ${[...zones.values()].reduce((n, z) => n + z.polygons.length, 0)} pieces in AREA, ${dropped} outside or too small, ${skipped} without a name or area`)

// The sector names in the data must be the ones the city state exports (SECTORS).
const dataSectors = new Set(sourceZones.filter((z) => z.kind === "sector").map((z) => z.name))
const dataAreas = new Set(sourceZones.filter((z) => z.kind !== "sector").map((z) => z.name))
for (const sector of SECTORS) {
  const found = sector.kind === "sector" ? dataSectors.has(sector.name) : dataAreas.has(sector.name)
  if (sector.slug !== slugify(sector.name)) {
    console.error(`MISMATCH ${sector.name}: slug "${sector.slug}" is not "${slugify(sector.name)}"`)
    process.exitCode = 1
  }
  if (!found) {
    console.error(`MISSING  ${sector.kind} "${sector.name}" is in SECTORS but not in the data`)
    process.exitCode = 1
  }
}
for (const name of dataSectors) {
  if (!SECTORS.some((s) => s.kind === "sector" && s.name === name)) {
    console.error(`NEW      sector "${name}" is in the data but not in SECTORS: add it to src/layers/circulation.ts`)
    process.exitCode = 1
  }
}

// Knips: every line whose middle lies inside AREA.
const knips: CirculationFile["knips"] = []
const sourceKnips = await features("knips")
for (const feature of sourceKnips) {
  for (const line of linesFromGeometry(feature.geometry)) {
    const mid = line[Math.floor(line.length / 2)]
    if (mid == null || !inArea(mid)) continue
    knips.push({ kind: knipKind(feature.properties?.type), line: encodePoints(line) })
  }
}
console.log(`knips    ${sourceKnips.length} records: ${knips.length} inside AREA`)

const file: CirculationFile = {
  source: "Stad Gent open data, sectoren-circulatieplan-gent and knips-circulatieplan-gent; Modellicentie Gratis Hergebruik",
  area: [rect.minX, rect.minZ, rect.maxX, rect.maxZ],
  // Sectors first, then the car-free pieces and pedestrian streets drawn over them.
  zones: [...zones.values()]
    .sort((a, b) => ["sector", "car-free", "pedestrian"].indexOf(a.kind) - ["sector", "car-free", "pedestrian"].indexOf(b.kind))
    .map((z) => ({ name: z.name, kind: z.kind, polygons: z.polygons.map((p) => p.map(encodePoints)) })),
  knips,
}

// The plan as the layer will read it: the Kuip in the middle, a sector on every side.
const data = parseCirculationFile(file)
const probes: Array<{ what: string; at: XZ; slug: string }> = [
  { what: "the Belfry", at: [0, 0], slug: "kuip" },
  { what: "the Korenmarkt", at: [-200, -20], slug: "kuip" },
  { what: "the west edge", at: [rect.minX + 30, 0], slug: "coupure" },
  { what: "the north edge", at: [0, rect.minZ + 30], slug: "tolhuis" },
  { what: "the east edge", at: [rect.maxX - 30, 0], slug: "portus-ganda" },
  { what: "the south edge", at: [0, rect.maxZ - 30], slug: "krook" },
]
for (const probe of probes) {
  const got = zoneAt(data, probe.at)
  console.log(`${got === probe.slug ? "ok     " : "WRONG  "} ${probe.what} (${probe.at.join(", ")}) is ${got ?? "no zone"}, expected ${probe.slug}`)
  if (got !== probe.slug) process.exitCode = 1
}
const sectorZones = data.zones.filter((z) => z.kind === "sector")
const neighbours = findNeighbours(sectorZones, 6, data.area)
const colours = colourSectors([...new Set(sectorZones.map((z) => z.slug))], neighbours)
for (const [slug, set] of neighbours) console.log(`colour ${colours.get(slug)} ${slug.padEnd(13)} next to ${[...set].join(", ") || "none"}`)

// One zone or knip per line, so a later refresh diffs readably.
const text =
  `{"source":${JSON.stringify(file.source)},\n"area":${JSON.stringify(file.area)},\n` +
  `"zones":[\n${file.zones.map((z) => JSON.stringify(z)).join(",\n")}],\n` +
  `"knips":[\n${file.knips.map((k) => JSON.stringify(k)).join(",\n")}]}\n`
mkdirSync("public/fixtures", { recursive: true })
writeFileSync(OUT, text)
const bytes = statSync(OUT).size
console.log(`${OUT}: ${(bytes / 1024).toFixed(0)} KB`)
if (bytes > MAX_FIXTURE_BYTES) {
  console.error(`the fixture is over ${MAX_FIXTURE_BYTES / 1024} KB: raise a tolerance or minArea`)
  process.exitCode = 1
}
