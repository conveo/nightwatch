import type { LatLon } from "./geo.ts"

// Values more than one layer depends on. They live here, not in a layer file, so
// tickets that build those layers in parallel agree without editing each other.

// The area drawn: the historic centre, about 1.4 km by 1.4 km around the Belfry, with
// the Graslei, the Gravensteen, the Patershol, the Vrijdagmarkt and the Kouter.
export const AREA: { south: number; north: number; west: number; east: number } = {
  south: 51.047,
  north: 51.06,
  west: 3.714,
  east: 3.734,
}

export function inArea(p: LatLon): boolean {
  return p.lat >= AREA.south && p.lat <= AREA.north && p.lon >= AREA.west && p.lon <= AREA.east
}

// Water (the Leie, the Schelde, the canals) is drawn this far below street level
// (metres, y is up), so quays read as edges from the street-level view.
export const WATER_LEVEL_M = -2.5

// Zones drawn on the ground (the circulation plan) sit just above it, and ground
// overlays never fight each other for the same depth.
export const GROUND_OVERLAY_Y_M = 0.3

// Fixtures under public/fixtures/ cover a smaller circle around the Belfry, so tests
// and screenshots load in under a second without network.
export const FIXTURE_RADIUS_M = 300
