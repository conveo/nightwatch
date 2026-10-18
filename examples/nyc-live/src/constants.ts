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

// The subway is drawn again, see-through, so it reads from above and at night too: the
// tubes and stations through the ground (the ground does not hide what is drawn after
// it), the tubes once more, fainter, through the buildings, and the trains, which are
// what moves, clearly through both.
export const SUBWAY_XRAY_OPACITY = 0.35
export const SUBWAY_GHOST_OPACITY = 0.14
export const TRAINS_XRAY_OPACITY = 0.85

// From near the street the see-through subway would paint over the view, so it fades
// out as the camera comes down: gone at 40 m, full from 200 m up.
export function xrayFade(cameraHeightM: number): number {
  return Math.min(Math.max((cameraHeightM - 40) / 160, 0), 1)
}

// Fixtures under public/fixtures/ cover a smaller box around the venue, so tests and
// screenshots load in under a second without network.
export const FIXTURE_RADIUS_M = 400
