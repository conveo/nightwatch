import type { Group, Raycaster } from "three"
import type { DataMode, Light } from "../view-state.ts"

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
  // A short line for the HUD when something needs saying, for example "parking data
  // is 20 minutes old", or null when all is well. main.ts reads it every 5 seconds,
  // so a live layer can raise and clear it; the HUD hides when no layer has one.
  notice?(): string | null
  // Day or night. main.ts calls it whenever the lighting changes (and once at start),
  // so a layer can switch on its lights at night (the Lichtplan) or recolour itself.
  setLight?(light: Light): void
  // Selection. On a click, main.ts asks each layer in turn what the ray hits and
  // stores the first answer in the URL as `sel` (for example "bldg:1362089"); then
  // every layer gets select() with the new value, or null to clear it. The id
  // formats are listed in plan/PLAN.md ("Contracts").
  pick?(ray: Raycaster): string | null
  select?(id: string | null): void
}
