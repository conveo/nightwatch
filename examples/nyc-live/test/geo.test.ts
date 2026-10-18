import assert from "node:assert/strict"
import { test } from "node:test"
import { toLatLon, toLocal, VENUE } from "../src/geo.ts"

test("the venue is the origin", () => {
  const { x, z } = toLocal(VENUE)
  assert.equal(x, 0)
  assert.equal(Object.is(z, -0) ? 0 : z, 0)
})

test("north is -z and east is +x", () => {
  const north = toLocal({ lat: VENUE.lat + 0.001, lon: VENUE.lon })
  const east = toLocal({ lat: VENUE.lat, lon: VENUE.lon + 0.001 })
  assert.ok(north.z < 0 && Math.abs(north.x) < 1e-9)
  assert.ok(east.x > 0 && Math.abs(east.z) < 1e-9)
})

test("one thousandth of a degree is about 111 m north and 84 m east here", () => {
  assert.ok(Math.abs(-toLocal({ lat: VENUE.lat + 0.001, lon: VENUE.lon }).z - 111.3) < 0.5)
  assert.ok(Math.abs(toLocal({ lat: VENUE.lat, lon: VENUE.lon + 0.001 }).x - 84.3) < 0.5)
})

test("toLatLon inverts toLocal across lower Manhattan", () => {
  // Battery Park, Brooklyn Bridge, Union Square.
  for (const p of [
    { lat: 40.7033, lon: -74.017 },
    { lat: 40.7061, lon: -73.9969 },
    { lat: 40.7359, lon: -73.9911 },
  ]) {
    const back = toLatLon(toLocal(p))
    assert.ok(Math.abs(back.lat - p.lat) < 1e-9)
    assert.ok(Math.abs(back.lon - p.lon) < 1e-9)
  }
})
