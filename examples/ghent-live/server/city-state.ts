import type { Place } from "../src/places.ts"

// What "ask Ghent" (T7) knows about the city at one moment. The base owns this type
// so the tickets that fill it (T5 parking, T6 bikes, T3's sector names) and the one
// that reads it (T7) agree without editing each other's files. Change it only
// through the orchestrator.

export type GarageState = {
  slug: string // as in `garage:<slug>`, e.g. "vrijdagmarkt"
  name: string
  lat: number
  lon: number
  capacity: number
  available: number
  updated: string // ISO 8601, the feed's own time for this garage
}

export type BikeStationState = {
  operator: "donkey" | "bolt" | "blue-bike"
  id: string // as in `bikes:<operator>:<id>`
  name: string
  lat: number
  lon: number
  available: number
}

export type CityState = {
  time: string // ISO 8601: "now" in live mode, the data time in recorded or fixture mode
  garages: GarageState[]
  bikes: BikeStationState[]
  sectors: string[] // circulation plan sector names, as in `sector:<slug>`
  places: Place[] // src/places.ts
}

// T7 ships a provider that reads fixtures; T9 wires one that reads the live routes.
export type CityStateProvider = {
  current(options: { mode: "fixture" | "recorded" | "live"; time: string | null }): Promise<CityState>
}
