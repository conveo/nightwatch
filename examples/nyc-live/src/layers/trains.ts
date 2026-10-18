import { Group } from "three"
import type { Layer } from "./types.ts"

// Live train positions from the MTA's realtime feeds, moving along the subway lines.
// Owned by ticket T4 in plan/PLAN.md. Until then this layer draws nothing.
export function createTrainsLayer(): Layer {
  const group = new Group()
  group.name = "trains"
  return {
    id: "trains",
    group,
    async init() {},
  }
}
