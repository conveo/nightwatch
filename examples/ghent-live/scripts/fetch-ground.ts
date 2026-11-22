// Download the ground for AREA from Digitaal Vlaanderen's GRB WFS and write the
// fixture the ground layer draws (ticket T2 in plan/PLAN.md):
//
//   node scripts/fetch-ground.ts             # reuses data/ground/*.json when present
//   node scripts/fetch-ground.ts --refresh   # downloads again
//
// Water surfaces (GRB:WTZ, "watergang"), road surfaces (GRB:WBN, "wegbaan") and
// bridges (GRB:KNW, "kunstwerk", type "overbrugging": the road surface stops at a
// bridge's ends, the bridge itself is a kunstwerk). The raw answers go to data/ground/
// (ignored); public/fixtures/ground.json gets every polygon clipped to AREA,
// simplified, small ones dropped and coordinates rounded to 0.1 m, in scene metres.
// The ground does not change, so the fixture covers the whole area and every data
// mode draws it.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { AREA } from "../src/constants.ts"
import {
  areaRect,
  clipPolygon,
  encodeRing,
  pointInPolygon,
  polygonArea,
  polygonsFromGeometry,
  simplifyRing,
  type GroundFile,
  type Polygon,
  type XZ,
} from "../src/layers/ground.ts"

const WFS = "https://geo.api.vlaanderen.be/GRB/wfs"
const RAW_DIR = "data/ground"
const OUT = "public/fixtures/ground.json"
const MAX_FEATURES = 10_000
const MAX_FIXTURE_BYTES = 300 * 1024

type Feature = { type: "Feature"; geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> }

// What to keep of each layer: tolerance for simplifying (m) and the smallest area (m²).
const LAYERS = {
  water: { typeName: "GRB:WTZ", tolerance: 0.4, minArea: 20, keep: (_: Feature) => true },
  roads: { typeName: "GRB:WBN", tolerance: 0.5, minArea: 6, keep: (_: Feature) => true },
  bridges: { typeName: "GRB:KNW", tolerance: 0.3, minArea: 6, keep: (f: Feature) => f.properties.LBLTYPE === "overbrugging" },
} as const

const { values } = parseArgs({ options: { refresh: { type: "boolean", default: false } } })

async function download(typeName: string): Promise<Feature[]> {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: typeName,
    outputFormat: "application/json",
    // GeoJSON positions come back as [lon, lat]; the bbox in this CRS is lat, lon.
    srsName: "EPSG:4326",
    bbox: `${AREA.south},${AREA.west},${AREA.north},${AREA.east},urn:ogc:def:crs:EPSG::4326`,
    count: String(MAX_FEATURES),
  })
  const res = await fetch(`${WFS}?${params}`, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`${typeName}: HTTP ${res.status}`)
  const body = (await res.json()) as { type?: string; features?: Feature[] }
  if (body.type !== "FeatureCollection" || !Array.isArray(body.features)) throw new Error(`${typeName}: not a FeatureCollection`)
  if (body.features.length >= MAX_FEATURES) throw new Error(`${typeName}: ${MAX_FEATURES} features or more, raise MAX_FEATURES`)
  return body.features
}

async function features(name: string, typeName: string): Promise<Feature[]> {
  const path = `${RAW_DIR}/${name}.json`
  if (!values.refresh && existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Feature[]
  const list = await download(typeName)
  mkdirSync(RAW_DIR, { recursive: true })
  writeFileSync(path, JSON.stringify(list))
  return list
}

const rect = areaRect()
const out: Record<keyof typeof LAYERS, Polygon[]> = { water: [], roads: [], bridges: [] }
for (const [name, layer] of Object.entries(LAYERS) as Array<[keyof typeof LAYERS, (typeof LAYERS)[keyof typeof LAYERS]]>) {
  const list = (await features(name, layer.typeName)).filter(layer.keep)
  let dropped = 0
  for (const feature of list) {
    for (const polygon of polygonsFromGeometry(feature.geometry)) {
      const clipped = clipPolygon(polygon, rect)
      const simple = clipped?.map((ring) => simplifyRing(ring, layer.tolerance)).filter((ring) => ring.length >= 3)
      if (simple == null || simple.length === 0 || polygonArea(simple) < layer.minArea) {
        dropped++
        continue
      }
      out[name].push(simple)
    }
  }
  console.log(`${name.padEnd(8)} ${layer.typeName}: ${list.length} features, ${out[name].length} polygons kept, ${dropped} dropped`)
}

// The river must run where the city's quays are: along the Graslei and through the
// Nederschelde, and the Sint-Michielsbrug must be a bridge over the Leie.
const probes: Array<{ what: string; at: XZ; in: keyof typeof LAYERS }> = [
  { what: "the Leie off the Graslei", at: [-300, -200], in: "water" },
  { what: "the Leie under the Sint-Michielsbrug", at: [-310, -19], in: "water" },
  { what: "the Sint-Michielsbrug", at: [-310, -19], in: "bridges" },
  { what: "the Nederschelde", at: [250, 193], in: "water" },
]
for (const probe of probes) {
  const hit = out[probe.in].some((polygon) => pointInPolygon(probe.at, polygon))
  console.log(`${hit ? "ok     " : "MISSING"} ${probe.what} (${probe.in} at ${probe.at.join(", ")})`)
  if (!hit) process.exitCode = 1
}

const file: GroundFile = {
  source: "GRB (Digitaal Vlaanderen), WFS layers WTZ, WBN and KNW (overbrugging); Modellicentie Gratis Hergebruik",
  area: [rect.minX, rect.minZ, rect.maxX, rect.maxZ].map((v) => Math.round(v * 10) / 10) as GroundFile["area"],
  water: out.water.map((p) => p.map(encodeRing)),
  roads: out.roads.map((p) => p.map(encodeRing)),
  bridges: out.bridges.map((p) => p.map(encodeRing)),
}
// One polygon per line, so a later refresh diffs readably.
const lines = (list: number[][][]) => list.map((p) => JSON.stringify(p)).join(",\n")
const text =
  `{"source":${JSON.stringify(file.source)},\n"area":${JSON.stringify(file.area)},\n` +
  `"water":[\n${lines(file.water)}],\n"roads":[\n${lines(file.roads)}],\n"bridges":[\n${lines(file.bridges)}]}\n`
mkdirSync("public/fixtures", { recursive: true })
writeFileSync(OUT, text)
const bytes = statSync(OUT).size
console.log(`${OUT}: ${(bytes / 1024).toFixed(0)} KB`)
if (bytes > MAX_FIXTURE_BYTES) {
  console.error(`the fixture is over ${MAX_FIXTURE_BYTES / 1024} KB: raise a tolerance or minArea`)
  process.exitCode = 1
}
