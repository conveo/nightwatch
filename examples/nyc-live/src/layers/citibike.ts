import { Group } from "three"
import type { Layer } from "./types.ts"

// Citi Bike docks as bars whose height is the number of bikes available.
// Owned by ticket T5 in plan/PLAN.md. Until then this layer draws nothing.
export function createCitibikeLayer(): Layer {
  const group = new Group()
  group.name = "citibike"
  return {
    id: "citibike",
    group,
    async init() {},
  }
}
