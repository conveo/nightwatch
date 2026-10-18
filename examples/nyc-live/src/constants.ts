import type { LatLon } from "./geo.ts"

// Values more than one layer depends on. They live here, not in a layer file, so
// tickets that build those layers in parallel agree without editing each other.

// The area drawn: the Battery up to 17th Street, the Hudson to the East River.
export const AREA: { south: number; north: number; west: number; east: number } = {
  south: 40.6995,
  north: 40.74,
  west: -74.02,
  east: -73.97,
}

export function inArea(p: LatLon): boolean {
  return p.lat >= AREA.south && p.lat <= AREA.north && p.lon >= AREA.west && p.lon <= AREA.east
}

// Subway lines run this far below street level (metres, y is up). The ground is
// drawn slightly transparent so they show through from above.
export const SUBWAY_DEPTH_M = -12
export const GROUND_OPACITY = 0.82

// The subway's tubes and its trains are drawn a second time, see-through and over
// everything else, so they read through the buildings and the ground from any angle,
// at night too. Trains are what moves, so they show the most.
export const SUBWAY_XRAY_OPACITY = 0.28
export const TRAINS_XRAY_OPACITY = 0.85

// Fixtures under public/fixtures/ cover a smaller box around the venue, so tests and
// screenshots load in under a second without network.
export const FIXTURE_RADIUS_M = 400
