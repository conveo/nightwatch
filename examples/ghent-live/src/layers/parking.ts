import { Group } from "three"
import type { Layer } from "./types.ts"

// Parking garages with their live occupancy, read through the dev server's own
// /api/parking route (Stad Gent open data). Owned by ticket T5 in plan/PLAN.md.
// Until then this layer draws nothing.
export function createParkingLayer(): Layer {
  const group = new Group()
  group.name = "parking"
  return {
    id: "parking",
    group,
    async init() {},
  }
}
