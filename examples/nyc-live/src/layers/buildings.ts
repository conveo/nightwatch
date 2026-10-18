import { Group } from "three"
import type { Layer } from "./types.ts"

// Lower Manhattan's buildings, extruded from NYC Open Data footprints and heights.
// Owned by ticket T1 in plan/PLAN.md. Until then this layer draws nothing.
export function createBuildingsLayer(): Layer {
  const group = new Group()
  group.name = "buildings"
  return {
    id: "buildings",
    group,
    async init() {},
  }
}
