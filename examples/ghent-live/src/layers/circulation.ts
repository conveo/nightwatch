import { Group } from "three"
import type { Layer } from "./types.ts"

// The 2017 circulation plan: its sectors, the car-free area and the "knips" (the
// points where cars cannot pass from one sector to the next), from Stad Gent open
// data. Owned by ticket T3 in plan/PLAN.md. Until then this layer draws nothing.
export function createCirculationLayer(): Layer {
  const group = new Group()
  group.name = "circulation"
  return {
    id: "circulation",
    group,
    async init() {},
  }
}
