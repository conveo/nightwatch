import { createBuildingsLayer } from "./buildings.ts"
import { createCitibikeLayer } from "./citibike.ts"
import { createGroundLayer } from "./ground.ts"
import { createSubwayLayer } from "./subway.ts"
import { createTrainsLayer } from "./trains.ts"
import type { Layer } from "./types.ts"
import { createVenueLayer } from "./venue.ts"

// The full list of layers, in draw order. Tickets fill in their own file; nobody
// needs to edit this list, which is what lets the layers be built in parallel.
export function createLayers(): Layer[] {
  return [
    createGroundLayer(),
    createBuildingsLayer(),
    createSubwayLayer(),
    createTrainsLayer(),
    createCitibikeLayer(),
    createVenueLayer(),
  ]
}
