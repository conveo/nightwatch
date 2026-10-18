// Scene coordinates are metres on a flat plane around one origin: x points east,
// z points south (three.js is y-up, so north is -z). Lower Manhattan is small
// enough that an equirectangular projection is accurate to well under a metre.

export type LatLon = { lat: number; lon: number }
export type Local = { x: number; z: number }

// 598 Broadway, the venue (NYC GeoSearch; BIN 1007945).
export const VENUE: LatLon & { bin: string } = { lat: 40.724951, lon: -73.996627, bin: "1007945" }

const EARTH_RADIUS_M = 6_378_137
const DEG = Math.PI / 180

export function toLocal(point: LatLon, origin: LatLon = VENUE): Local {
  const x = (point.lon - origin.lon) * DEG * EARTH_RADIUS_M * Math.cos(origin.lat * DEG)
  const z = -(point.lat - origin.lat) * DEG * EARTH_RADIUS_M
  return { x, z }
}

export function toLatLon(local: Local, origin: LatLon = VENUE): LatLon {
  const lat = origin.lat - local.z / (DEG * EARTH_RADIUS_M)
  const lon = origin.lon + local.x / (DEG * EARTH_RADIUS_M * Math.cos(origin.lat * DEG))
  return { lat, lon }
}

// Manhattan's street grid runs about 29 degrees east of true north. Camera presets
// and the street layer use this to line views up with the avenues.
export const MANHATTAN_GRID_ROTATION_DEG = 29
