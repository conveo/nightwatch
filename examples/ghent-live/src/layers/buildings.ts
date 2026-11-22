import { Group } from "three"
import type { Layer } from "./types.ts"

// The centre's buildings: GRB footprints (Digitaal Vlaanderen) extruded to heights
// from the DHMV elevation model. Owned by ticket T1 in plan/PLAN.md. Until then this
// layer draws nothing.
export function createBuildingsLayer(): Layer {
  const group = new Group()
  group.name = "buildings"
  return {
    id: "buildings",
    group,
    async init() {},
  }
}
