import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_VIEW, parseViewState, serializeViewState, type ViewState } from "../src/view-state.ts"

test("an empty hash is the default view", () => {
  assert.deepEqual(parseViewState(""), DEFAULT_VIEW)
  assert.deepEqual(parseViewState("#"), DEFAULT_VIEW)
})

test("a full view survives a round trip through the URL", () => {
  const view: ViewState = {
    cam: [120.25, 380, -520.5],
    tgt: [10, 0, -40],
    sel: "bin:1007945",
    mode: "recorded",
    t: "2026-10-21T23:10:00Z",
    layers: ["buildings", "subway"],
    light: "night",
  }
  const hash = serializeViewState(view)
  assert.deepEqual(parseViewState(hash), { ...view, cam: [120.3, 380, -520.5] })
})

test("the hash stays readable in a review note", () => {
  const hash = serializeViewState({ ...DEFAULT_VIEW, sel: "bin:1007945", t: "2026-10-21T23:10:00Z" })
  assert.equal(hash, "#cam=320,420,620&tgt=0,0,0&sel=bin:1007945&mode=fixture&t=2026-10-21T23:10:00Z")
})

test("malformed values fall back to the defaults", () => {
  const view = parseViewState("#cam=1,2&tgt=a,b,c&mode=satellite&t=yesterday&layers=")
  assert.deepEqual(view.cam, DEFAULT_VIEW.cam)
  assert.deepEqual(view.tgt, DEFAULT_VIEW.tgt)
  assert.equal(view.mode, "fixture")
  assert.equal(view.t, null)
  assert.equal(view.layers, null)
  assert.equal(parseViewState("#light=dusk").light, "day")
})
