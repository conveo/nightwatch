import assert from "node:assert/strict"
import { test } from "node:test"
import { followCamera, statusLine } from "../src/hud.ts"

test("the status line is empty when no layer has anything to say", () => {
  assert.equal(statusLine([{ id: "ground" }, { id: "parking", notice: () => null }], new Map()), "")
})

test("notices come first, then failures", () => {
  const line = statusLine(
    [{ id: "parking", notice: () => "parking data is 20 minutes old" }, { id: "bikes" }],
    new Map([["buildings", "Error: 503"]]),
  )
  assert.equal(line, "parking data is 20 minutes old · buildings failed: Error: 503")
})

test("the URL follows a gliding camera, at most once per interval, and once more at the end", async () => {
  let clock = 0
  let saves = 0
  const follow = followCamera(() => saves++, 100, () => clock)
  follow.moved() // first move saves at once
  clock = 50
  follow.moved() // too soon: only a trailing save is scheduled
  assert.equal(saves, 1)
  clock = 150
  follow.moved() // an interval later: saves again
  assert.equal(saves, 2)
  follow.ended()
  assert.equal(saves, 3)
  await new Promise((resolve) => setTimeout(resolve, 150)) // ended() cancelled the trailing save
  assert.equal(saves, 3)
})
