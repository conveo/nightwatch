// Scene coordinates are metres on a flat plane around one origin: x points east,
// z points south (three.js is y-up, so north is -z). Ghent's centre is small enough
// that an equirectangular projection is accurate to well under a metre.

export type LatLon = { lat: number; lon: number }
export type Local = { x: number; z: number }

// The Belfry (Belfort en Lakenhalle), the scene origin. Coordinates from Stad Gent's
// Lichtplan points of interest (data.stad.gent).
export const ORIGIN: LatLon = { lat: 51.053686, lon: 3.724972 }

const EARTH_RADIUS_M = 6_378_137
const DEG = Math.PI / 180

export function toLocal(point: LatLon, origin: LatLon = ORIGIN): Local {
  const x = (point.lon - origin.lon) * DEG * EARTH_RADIUS_M * Math.cos(origin.lat * DEG)
  const z = -(point.lat - origin.lat) * DEG * EARTH_RADIUS_M
  return { x, z }
}

export function toLatLon(local: Local, origin: LatLon = ORIGIN): LatLon {
  const lat = origin.lat - local.z / (DEG * EARTH_RADIUS_M)
  const lon = origin.lon + local.x / (DEG * EARTH_RADIUS_M * Math.cos(origin.lat * DEG))
  return { lat, lon }
}
