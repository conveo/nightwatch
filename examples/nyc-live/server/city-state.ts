// The city state that "ask the city" answers from: where the subway stations and
// named places are (static), and how the lines and Citi Bike docks are doing at one
// moment (changes). A CityStateProvider returns one snapshot per data mode; T6 ships
// the fixture provider below, and T8 registers providers for recorded and live mode
// built from T4's trains and T5's docks (see `setCityStateProvider`).

import { toLocal, VENUE, type LatLon } from "../src/geo.ts"
import type { DataMode } from "../src/view-state.ts"

export type Station = { id: string; name: string; lat: number; lon: number; lines: string[] }
export type Place = { id: string; name: string; lat: number; lon: number }
export type LineStatus = "normal" | "delays" | "reduced" | "suspended"
export type LineService = {
  id: string
  // The MTA route colour, for the panel's line bullet.
  color: string
  status: LineStatus
  // Minutes between trains right now, or null when no trains run.
  headwayMin: number | null
  note: string | null
}
export type Dock = { id: string; name: string; lat: number; lon: number; bikes: number; ebikes: number; freeDocks: number }

export type CityState = {
  // The moment the snapshot describes (ISO 8601) and the data it came from.
  time: string
  source: DataMode
  stations: Station[]
  places: Place[]
  lines: LineService[]
  docks: Dock[]
}

export type CityStateProvider = {
  source: DataMode
  // `time` is the view's data time (recorded mode), or null for "now".
  get(time: string | null): Promise<CityState>
}

// Stations near the venue and near each named place, from the MTA's static GTFS
// stops (rounded). T3 exports the full list; this one is just what the questions need.
export const STATIONS: Station[] = [
  { id: "R22", name: "Prince St", lat: 40.724329, lon: -73.997702, lines: ["R", "W"] },
  { id: "D21", name: "Broadway-Lafayette St", lat: 40.725297, lon: -73.996204, lines: ["B", "D", "F", "M"] },
  { id: "637", name: "Bleecker St", lat: 40.725915, lon: -73.994659, lines: ["6"] },
  { id: "638", name: "Spring St", lat: 40.722301, lon: -73.997141, lines: ["6"] },
  { id: "A33", name: "Spring St", lat: 40.726227, lon: -74.003739, lines: ["C", "E"] },
  { id: "640", name: "Brooklyn Bridge-City Hall", lat: 40.713065, lon: -74.004131, lines: ["4", "5", "6"] },
  { id: "R24", name: "City Hall", lat: 40.713282, lon: -74.006978, lines: ["R", "W"] },
  { id: "142", name: "South Ferry", lat: 40.702068, lon: -74.013664, lines: ["1"] },
  { id: "R27", name: "Whitehall St-South Ferry", lat: 40.703087, lon: -74.012994, lines: ["R", "W"] },
  { id: "E01", name: "World Trade Center", lat: 40.712582, lon: -74.009781, lines: ["E"] },
  { id: "R25", name: "Cortlandt St", lat: 40.710668, lon: -74.011029, lines: ["R", "W"] },
  { id: "R26", name: "Rector St", lat: 40.70722, lon: -74.013342, lines: ["R", "W"] },
  { id: "419", name: "Wall St", lat: 40.707557, lon: -74.011862, lines: ["4", "5"] },
  { id: "635", name: "14 St-Union Sq", lat: 40.734673, lon: -73.989951, lines: ["4", "5", "6", "L", "N", "Q", "R", "W"] },
  { id: "A32", name: "W 4 St-Wash Sq", lat: 40.732338, lon: -74.000495, lines: ["A", "C", "E", "B", "D", "F", "M"] },
  { id: "R21", name: "8 St-NYU", lat: 40.730328, lon: -73.992629, lines: ["R", "W"] },
]

// The places the route question can name.
export const PLACES: Place[] = [
  { id: "brooklyn-bridge", name: "Brooklyn Bridge", lat: 40.7123, lon: -74.004 },
  { id: "staten-island-ferry", name: "Staten Island Ferry", lat: 40.7013, lon: -74.0132 },
  { id: "world-trade-center", name: "World Trade Center", lat: 40.7115, lon: -74.011 },
  { id: "wall-street", name: "Wall Street", lat: 40.7069, lon: -74.0113 },
  { id: "union-square", name: "Union Square", lat: 40.7359, lon: -73.9906 },
  { id: "washington-square-park", name: "Washington Square Park", lat: 40.7308, lon: -73.9973 },
]

const LINE_COLORS: Record<string, string> = {
  "1": "#EE352E",
  "4": "#00933C",
  "5": "#00933C",
  "6": "#00933C",
  A: "#0039A6",
  C: "#0039A6",
  E: "#0039A6",
  B: "#FF6319",
  D: "#FF6319",
  F: "#FF6319",
  M: "#FF6319",
  L: "#A7A9AC",
  N: "#FCCC0A",
  Q: "#FCCC0A",
  R: "#FCCC0A",
  W: "#FCCC0A",
}

export function lineColor(line: string): string {
  return LINE_COLORS[line] ?? "#808183"
}

function service(id: string, headwayMin: number | null, status: LineStatus = "normal", note: string | null = null): LineService {
  return { id, color: lineColor(id), status, headwayMin, note }
}

// A hand-made sample for a weekday evening, not a real snapshot: one line is
// delayed and one dock near Union Square is full, so the answers have something to
// weigh. Tests, screenshots and the recorded answers all use it.
export const FIXTURE_CITY_STATE: CityState = {
  time: "2026-10-21T23:10:00Z",
  source: "fixture",
  stations: STATIONS,
  places: PLACES,
  lines: [
    service("R", 8),
    service("W", 10),
    service("B", 10),
    service("D", 8),
    service("F", 12, "delays", "signal problem; trains are running with delays"),
    service("M", 10),
    service("6", 5),
    service("C", 10),
    service("E", 6),
    service("4", 6),
    service("5", 8),
    service("1", 6),
    service("A", 8),
    service("L", 5),
    service("N", 8),
    service("Q", 8),
  ],
  docks: [
    { id: "lafayette-jersey", name: "Lafayette St & Jersey St", lat: 40.724561, lon: -73.995653, bikes: 3, ebikes: 1, freeDocks: 22 },
    { id: "mercer-spring", name: "Mercer St & Spring St", lat: 40.723627, lon: -73.999496, bikes: 7, ebikes: 2, freeDocks: 18 },
    { id: "mercer-bleecker", name: "Mercer St & Bleecker St", lat: 40.727064, lon: -73.996621, bikes: 12, ebikes: 0, freeDocks: 9 },
    { id: "centre-chambers", name: "Centre St & Chambers St", lat: 40.712733, lon: -74.004607, bikes: 4, ebikes: 0, freeDocks: 9 },
    { id: "south-whitehall", name: "South St & Whitehall St", lat: 40.701221, lon: -74.012342, bikes: 10, ebikes: 3, freeDocks: 14 },
    { id: "liberty-broadway", name: "Liberty St & Broadway", lat: 40.709056, lon: -74.010434, bikes: 2, ebikes: 1, freeDocks: 6 },
    { id: "william-pine", name: "William St & Pine St", lat: 40.707179, lon: -74.008873, bikes: 6, ebikes: 0, freeDocks: 8 },
    { id: "broadway-e14", name: "Broadway & E 14 St", lat: 40.734546, lon: -73.990741, bikes: 31, ebikes: 2, freeDocks: 0 },
    { id: "macdougal-washington", name: "MacDougal St & Washington Sq", lat: 40.732264, lon: -73.998522, bikes: 5, ebikes: 1, freeDocks: 11 },
  ],
}

export const fixtureProvider: CityStateProvider = {
  source: "fixture",
  get: async () => FIXTURE_CITY_STATE,
}

const providers: Partial<Record<DataMode, CityStateProvider>> = { fixture: fixtureProvider }

// T8 registers the recorded and live providers here.
export function setCityStateProvider(mode: DataMode, provider: CityStateProvider): void {
  providers[mode] = provider
}

// A mode with no provider yet answers from the fixture; the snapshot's `source`
// says so, and the panel shows it, so nobody mistakes it for live data.
export function cityStateProvider(mode: DataMode): CityStateProvider {
  return providers[mode] ?? fixtureProvider
}

// Straight-line distance in metres.
export function distanceM(a: LatLon, b: LatLon = VENUE): number {
  const p = toLocal(a, b)
  return Math.hypot(p.x, p.z)
}

export function nearby<T extends LatLon>(items: T[], from: LatLon, withinM: number): Array<T & { distanceM: number }> {
  return items
    .map((item) => ({ ...item, distanceM: distanceM(item, from) }))
    .filter((item) => item.distanceM <= withinM)
    .sort((a, b) => a.distanceM - b.distanceM)
}
