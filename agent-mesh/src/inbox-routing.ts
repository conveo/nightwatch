// Where an arriving batch goes, as a pure decision.
//
// Separated from `InboxWatcher` because this is the highest-consequence logic in the
// console and it was, until now, only reachable through a class that polls a daemon and
// writes to sockets. All three delivery bugs this feature has had lived in these
// branches, every one of them the same mistake — treating an ATTEMPT as a DELIVERY —
// and none of them was covered by a test, because there was nothing testable to point
// one at.
//
// The invariant, stated once: the read position may only move when something actually
// received the batch. A write to zero sockets, a push to zero devices, and a command
// that exits zero are all attempts. None of them is a delivery.

import type { MeshMessage } from "./types.js"

/** What to do with a batch, before anything is attempted. */
export type RouteIntent =
  /**
   * Someone is connected: write to the sockets. `notify` means nobody is LOOKING at
   * them — a backgrounded tab or a locked phone keeps its socket — so a notification
   * goes out too. Inline and push are additive, never either/or.
   */
  | { kind: "inline"; subscribers: number; notify: boolean }
  /** Nothing is connected but the operator is present: keep the position and re-offer next poll. */
  | { kind: "hold"; attempt: number }
  /** Nothing to deliver to inline. Try to notify instead. */
  | { kind: "quiet"; reason: "held-too-long" | "no-presence" }

export function routeIntent(args: { subscribers: number; watching: boolean; holds: number; maxHolds: number }): RouteIntent {
  if (args.subscribers > 0) {
    return { kind: "inline", subscribers: args.subscribers, notify: !args.watching }
  }
  // Present but detached is the interesting case: a foregrounded tab mid-reconnect has
  // no socket, so emitting would reach nothing while presence says they are there. Hold
  // instead — but only for a bounded number of polls, because a tab that keeps
  // beaconing while its stream stays broken must not hold mail forever.
  if (args.watching && args.holds < args.maxHolds) {
    return { kind: "hold", attempt: args.holds + 1 }
  }
  return { kind: "quiet", reason: args.watching ? "held-too-long" : "no-presence" }
}

/**
 * What a notification attempt actually achieved.
 *
 * `sent` is the number of devices reached, not the number attempted, and it is the only
 * thing that may move the read position. Zero means the batch is still undelivered and
 * must stay pending — the alternative loses it permanently, because nothing re-offers a
 * batch the position has already passed.
 */
export function quietOutcome(sent: number): { advance: boolean; routed: "push" | "undeliverable" } {
  return sent > 0 ? { advance: true, routed: "push" } : { advance: false, routed: "undeliverable" }
}

/**
 * Which fresh messages to offer this poll, and how far the read position may move.
 *
 * The oldest `maxBurst` are offered and the position moves no further than the last of
 * them, so anything beyond the cap is offered on the next poll rather than skipped. A
 * cap that kept the NEWEST and advanced past the whole burst lost every older message
 * permanently — nothing re-offers what the position has passed. Stale backlog is the
 * recency cutoff's job, not this one's; this only bounds how much lands at once.
 *
 * A caller's own publishes come back through its inbox on the broadcast stream and are
 * never offered — echoing them would narrate the operator's own words back to them.
 */
export function selectBatch(args: { fresh: MeshMessage[]; me: string; maxBurst: number; newest: string }):
  | { kind: "deliver"; inbound: MeshMessage[]; through: string }
  | { kind: "own-only"; through: string } {
  const inbound = args.fresh.filter((m) => m.from !== args.me)
  if (inbound.length === 0) {
    return { kind: "own-only", through: args.newest }
  }
  const batch = inbound.slice(0, args.maxBurst)
  const truncated = batch.length < inbound.length
  return { kind: "deliver", inbound: batch, through: truncated ? batch[batch.length - 1].id : args.newest }
}
