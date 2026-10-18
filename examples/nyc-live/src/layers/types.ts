import type { Group, Raycaster } from "three"
import type { DataMode } from "../view-state.ts"

export type LayerContext = {
  mode: DataMode
  // The data time for recorded mode (ISO 8601), or null for "now".
  time: string | null
}

// One layer per ticket: each lives in its own file under src/layers/ and owns only
// its group, so parallel workers never edit the same file. main.ts adds every
// layer's group to the scene and calls init() once, then update() every frame.
export type Layer = {
  id: string
  group: Group
  init(ctx: LayerContext): Promise<void>
  update?(nowMs: number, dtMs: number): void
  // A short line for the HUD once the layer has loaded, for example "1,204 buildings".
  summary?(): string | null
  // Selection. On a click, main.ts asks each layer in turn what the ray hits and
  // stores the first answer in the URL as `sel` (for example "bin:1007945"); then
  // every layer gets select() with the new value, or null to clear it.
  pick?(ray: Raycaster): string | null
  select?(id: string | null): void
}
