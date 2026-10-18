// The inbound routing decision table.
//
// Every delivery bug this console has had lived in these four branches, and each one
// was the same mistake: treating an attempt as a delivery. The cases below are written
// as the consequence, not as the branch — "a batch nobody received does not move the
// position" rather than "quietOutcome(0).advance === false" — because the branch is
// obvious and the consequence is the thing that keeps being got wrong.

import assert from "node:assert/strict"
import { quietOutcome, routeIntent, selectBatch } from "../inbox-routing.js"
import type { MeshMessage } from "../types.js"

const MAX = 20

export function runInboxRoutingTest(): number {
  let failures = 0
  const check = (name: string, test: () => void) => {
    try {
      test()
      console.log(`  [PASS] ${name}`)
    } catch (error) {
      failures++
      console.error(`  [FAIL] ${name}`, error)
    }
  }

  console.log("\n[inbox] routing decisions")

  check("a tab the operator is looking at gets the batch inline, with no notification", () => {
    assert.deepEqual(routeIntent({ subscribers: 2, watching: true, holds: 0, maxHolds: MAX }), { kind: "inline", subscribers: 2, notify: false })
  })

  check("a connected but HIDDEN tab gets the batch inline AND a notification", () => {
    // Inline and push are additive. A backgrounded tab — or a locked phone with the app
    // still connected — keeps its socket, so routing by socket alone delivered into a
    // screen nobody was looking at and sent no push at all.
    assert.deepEqual(routeIntent({ subscribers: 1, watching: false, holds: 0, maxHolds: MAX }), { kind: "inline", subscribers: 1, notify: true })
  })

  check("present but detached HOLDS rather than emitting into nothing", () => {
    // The original bug: a foregrounded tab mid-reconnect has zero sockets, so the write
    // reached nobody while presence said they were there — and the position moved anyway.
    assert.deepEqual(routeIntent({ subscribers: 0, watching: true, holds: 0, maxHolds: MAX }), { kind: "hold", attempt: 1 })
  })

  check("the hold counts up so it can be bounded", () => {
    assert.deepEqual(routeIntent({ subscribers: 0, watching: true, holds: 7, maxHolds: MAX }), { kind: "hold", attempt: 8 })
  })

  check("a tab that beacons forever with a broken stream does not hold mail forever", () => {
    assert.deepEqual(routeIntent({ subscribers: 0, watching: true, holds: MAX, maxHolds: MAX }), { kind: "quiet", reason: "held-too-long" })
  })

  check("nobody present goes straight to a notification, without burning the holds", () => {
    assert.deepEqual(routeIntent({ subscribers: 0, watching: false, holds: 0, maxHolds: MAX }), { kind: "quiet", reason: "no-presence" })
  })

  check("the two quiet reasons are distinguishable, because they mean different things", () => {
    // held-too-long says their stream is broken; no-presence says they are away. Collapsing
    // them loses the only signal that the socket layer is failing.
    const brokenStream = routeIntent({ subscribers: 0, watching: true, holds: MAX, maxHolds: MAX })
    const away = routeIntent({ subscribers: 0, watching: false, holds: 0, maxHolds: MAX })
    assert.notEqual(brokenStream.kind === "quiet" && brokenStream.reason, away.kind === "quiet" && away.reason)
  })

  check("a notification that reached a device moves the position", () => {
    assert.deepEqual(quietOutcome(1), { advance: true, routed: "push" })
  })

  check("a notification that reached NOBODY does not move the position", () => {
    // The bug this closes: with zero registered devices every arrival routed "push",
    // reached nobody, and was marked handled — so no later tab was ever offered it.
    assert.deepEqual(quietOutcome(0), { advance: false, routed: "undeliverable" })
  })

  check("reaching one device out of many still counts", () => {
    // Partial delivery is delivery: they have been told. Holding for the other devices
    // would re-notify the one that already buzzed on every subsequent poll.
    assert.equal(quietOutcome(3).advance, true)
  })

  const msg = (n: number, from = "worker"): MeshMessage => ({
    id: `${1000 + n}-0`,
    ts: "2026-09-23T08:00:00Z",
    from,
    to: "operator",
    type: "status",
    body: { text: `m${n}` },
    correlationId: null,
    replyTo: null,
    channel: "mesh:inbox:operator",
  })
  const range = (n: number) => Array.from({ length: n }, (_, i) => msg(i + 1))

  check("a burst over the cap delivers the OLDEST and leaves the rest for the next poll", () => {
    // The regression: keeping the newest 20 and advancing past all 25 skipped the
    // first five for good.
    const fresh = range(25)
    const out = selectBatch({ fresh, me: "operator", maxBurst: 20, newest: fresh[24].id })
    assert.equal(out.kind, "deliver")
    if (out.kind !== "deliver") return
    assert.deepEqual(out.inbound.map((m) => m.body.text), fresh.slice(0, 20).map((m) => m.body.text))
    assert.equal(out.through, fresh[19].id, "the position must stop at the last message offered")
  })

  check("the rest of a burst arrives on the next poll, so nothing is skipped", () => {
    const fresh = range(25)
    const first = selectBatch({ fresh, me: "operator", maxBurst: 20, newest: fresh[24].id })
    if (first.kind !== "deliver") throw new Error("expected a delivery")
    const remaining = fresh.filter((m) => m.id > first.through)
    const second = selectBatch({ fresh: remaining, me: "operator", maxBurst: 20, newest: fresh[24].id })
    if (second.kind !== "deliver") throw new Error("expected a delivery")
    const offered = [...first.inbound, ...second.inbound].map((m) => m.body.text)
    assert.deepEqual(offered, fresh.map((m) => m.body.text))
  })

  check("a batch under the cap moves the position to the newest", () => {
    const fresh = range(5)
    assert.deepEqual(selectBatch({ fresh, me: "operator", maxBurst: 20, newest: fresh[4].id }), { kind: "deliver", inbound: fresh, through: fresh[4].id })
  })

  check("the operator's own echoed publishes are never offered", () => {
    const fresh = [msg(1, "operator"), msg(2, "operator")]
    assert.deepEqual(selectBatch({ fresh, me: "operator", maxBurst: 20, newest: fresh[1].id }), { kind: "own-only", through: fresh[1].id })
  })

  return failures
}
