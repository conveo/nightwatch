import { Group } from "three"
import type { Layer } from "./types.ts"

// The Lichtplan: the city's night lighting of its towers, bridges and quays, and the
// Lichtplan walk, from Stad Gent open data. Lights up at night (setLight). Owned by
// ticket T4 in plan/PLAN.md. Until then this layer draws nothing.
export function createLichtplanLayer(): Layer {
  const group = new Group()
  group.name = "lichtplan"
  return {
    id: "lichtplan",
    group,
    async init() {},
  }
}
