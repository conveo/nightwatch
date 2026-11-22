import { Group } from "three"
import type { Layer } from "./types.ts"

// Shared-bike stations (Donkey Republic, Bolt, Blue-bike) with the bikes available,
// read through the dev server's own /api/bikes route (Stad Gent open data). Owned
// by ticket T6 in plan/PLAN.md. Until then this layer draws nothing.
export function createBikesLayer(): Layer {
  const group = new Group()
  group.name = "bikes"
  return {
    id: "bikes",
    group,
    async init() {},
  }
}
