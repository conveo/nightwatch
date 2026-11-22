import assert from "node:assert/strict"
import { test } from "node:test"
import { inArea } from "../src/constants.ts"
import { ORIGIN, toLatLon, toLocal } from "../src/geo.ts"
import { PLACES, placeBySlug } from "../src/places.ts"

test("the Belfry is the origin", () => {
  const { x, z } = toLocal(ORIGIN)
  assert.equal(x, 0)
  assert.equal(Object.is(z, -0) ? 0 : z, 0)
})

test("north is -z and east is +x", () => {
  const north = toLocal({ lat: ORIGIN.lat + 0.001, lon: ORIGIN.lon })
  const east = toLocal({ lat: ORIGIN.lat, lon: ORIGIN.lon + 0.001 })
  assert.ok(north.z < 0 && Math.abs(north.x) < 1e-9)
  assert.ok(east.x > 0 && Math.abs(east.z) < 1e-9)
})

test("one thousandth of a degree is about 111 m north and 70 m east here", () => {
  assert.ok(Math.abs(-toLocal({ lat: ORIGIN.lat + 0.001, lon: ORIGIN.lon }).z - 111.3) < 0.5)
  assert.ok(Math.abs(toLocal({ lat: ORIGIN.lat, lon: ORIGIN.lon + 0.001 }).x - 70.0) < 0.5)
})

test("toLatLon inverts toLocal across the centre", () => {
  for (const p of PLACES) {
    const back = toLatLon(toLocal(p))
    assert.ok(Math.abs(back.lat - p.lat) < 1e-9)
    assert.ok(Math.abs(back.lon - p.lon) < 1e-9)
  }
})

test("every landmark is inside the area, and the Belfry is the origin", () => {
  for (const p of PLACES) assert.ok(inArea(p), `${p.slug} is outside AREA`)
  const belfort = placeBySlug("belfort")!
  assert.deepEqual({ lat: belfort.lat, lon: belfort.lon }, ORIGIN)
  assert.equal(placeBySlug("nowhere"), null)
})

test("the three towers stand in a row, west to east, within 250 m", () => {
  const [niklaas, belfort, baafs] = ["sint-niklaas", "belfort", "sint-baafs"].map((s) => toLocal(placeBySlug(s)!))
  assert.ok(niklaas!.x < belfort!.x && belfort!.x < baafs!.x)
  assert.ok(baafs!.x - niklaas!.x < 250)
})
