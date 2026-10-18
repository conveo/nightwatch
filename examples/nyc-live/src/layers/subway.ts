import { Group } from "three"
import type { Layer } from "./types.ts"

// The subway network: lines in their official colours below street level, and stations.
// Owned by ticket T3 in plan/PLAN.md. Until then this layer draws nothing.
export function createSubwayLayer(): Layer {
  const group = new Group()
  group.name = "subway"
  return {
    id: "subway",
    group,
    async init() {},
  }
}
