import { createBikesLayer } from "./bikes.ts"
import { createBuildingsLayer } from "./buildings.ts"
import { createCirculationLayer } from "./circulation.ts"
import { createGroundLayer } from "./ground.ts"
import { createLichtplanLayer } from "./lichtplan.ts"
import { createOriginLayer } from "./origin.ts"
import { createParkingLayer } from "./parking.ts"
import type { Layer } from "./types.ts"

// The full list of layers, in draw order. Tickets fill in their own file; nobody
// needs to edit this list, which is what lets the layers be built in parallel.
export function createLayers(): Layer[] {
  return [
    createGroundLayer(),
    createCirculationLayer(),
    createBuildingsLayer(),
    createLichtplanLayer(),
    createParkingLayer(),
    createBikesLayer(),
    createOriginLayer(),
  ]
}
