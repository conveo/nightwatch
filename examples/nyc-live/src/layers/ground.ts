import { Group, GridHelper } from "three"
import type { Layer } from "./types.ts"

// The ground: land, water (the Hudson and East River) and the street grid.
// Owned by ticket T2 in plan/PLAN.md. Until then it is a plain 100 m grid, so an
// empty scene still shows scale and orientation.
export function createGroundLayer(): Layer {
  const group = new Group()
  group.name = "ground"
  return {
    id: "ground",
    group,
    async init() {
      const grid = new GridHelper(4000, 40, 0x3a4a6a, 0x1c2438)
      group.add(grid)
    },
  }
}
