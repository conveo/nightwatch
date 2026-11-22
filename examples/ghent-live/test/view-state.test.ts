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
    sel: "garage:vrijdagmarkt",
    mode: "recorded",
    t: "2026-11-25T18:30:00Z",
    layers: ["buildings", "parking"],
    light: "night",
    ask: "drive:kuip~sector-zuid",
  }
  const hash = serializeViewState(view)
  assert.deepEqual(parseViewState(hash), { ...view, cam: [120.3, 380, -520.5] })
})

test("the hash stays readable in a review note", () => {
  const hash = serializeViewState({
    ...DEFAULT_VIEW,
    sel: "bldg:1362089",
    t: "2026-11-25T18:30:00Z",
    ask: "drive:kuip~sector-zuid",
  })
  assert.equal(
    hash,
    "#cam=-250,420,620&tgt=0,0,0&sel=bldg:1362089&mode=fixture&t=2026-11-25T18:30:00Z&ask=drive:kuip~sector-zuid",
  )
})

test("the question in the ask panel is part of the view", () => {
  assert.equal(parseViewState("#ask=park:gravensteen").ask, "park:gravensteen")
  assert.equal(parseViewState("#ask=").ask, null)
  assert.equal(parseViewState(serializeViewState(DEFAULT_VIEW)).ask, null)
})

test("malformed values fall back to the defaults", () => {
  const view = parseViewState("#cam=1,2&tgt=a,b,c&mode=satellite&t=yesterday")
  assert.deepEqual(view.cam, DEFAULT_VIEW.cam)
  assert.deepEqual(view.tgt, DEFAULT_VIEW.tgt)
  assert.equal(view.mode, "fixture")
  assert.equal(view.t, null)
  assert.equal(view.layers, null)
  assert.equal(parseViewState("#light=dusk").light, "day")
})

test("an explicitly empty layer list survives a round trip", () => {
  const none: ViewState = { ...DEFAULT_VIEW, layers: [] }
  assert.deepEqual(parseViewState(serializeViewState(none)).layers, [])
  assert.equal(parseViewState(serializeViewState(DEFAULT_VIEW)).layers, null)
})
