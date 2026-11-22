import { PLACES } from "../src/places.ts"
import type { BikeStationState, CityState, CityStateProvider, GarageState } from "./city-state.ts"

// A fixed snapshot of the city for "ask Ghent" in fixture mode, so the panel answers
// with no network and its recorded answers stay valid (a recording is keyed to the
// exact request, city state included). Taken from Stad Gent open data on 2026-11-22
// at 18:26 UTC, a Sunday evening:
//
// - garages: `bezetting-parkeergarages-real-time`, all 15, names verbatim, slugs by the
//   contract rule (B-Park Dampoort reported 221 free of 220; clamped to 220);
// - bikes: `donkey-republic-beschikbaarheid-deelfietsen-per-station`, the stations
//   within about 700 m of the Belfry that had bikes, plus a few empty ones. Bolt's
//   feed was months stale near the centre, so it is left out;
// - sectors: the circulation plan's sector names, as ticket T3 names them
//   (`sectoren-circulatieplan-gent`, field `naam`; Kuip is the car-free core).
//
// Ticket T9 wires a provider that reads the live routes instead.

const GARAGES: GarageState[] = [
  { slug: "b-park-dampoort", name: "B-Park Dampoort", lat: 51.0561, lon: 3.73956, capacity: 220, available: 220, updated: "2026-11-22T19:25:39+01:00" },
  { slug: "b-park-gent-sint-pieters", name: "B-Park Gent Sint-Pieters", lat: 51.0369, lon: 3.70502, capacity: 1000, available: 990, updated: "2026-11-22T19:23:44+01:00" },
  { slug: "dok-noord", name: "Dok noord", lat: 51.065685, lon: 3.732839, capacity: 550, available: 322, updated: "2026-11-22T19:26:00+01:00" },
  { slug: "getouw", name: "Getouw", lat: 51.07257, lon: 3.714831, capacity: 347, available: 336, updated: "2026-11-22T19:26:30+01:00" },
  { slug: "ledeberg", name: "Ledeberg", lat: 51.036342, lon: 3.738571, capacity: 495, available: 320, updated: "2026-11-22T19:26:31+01:00" },
  { slug: "p-r-the-loop", name: "P+R The Loop", lat: 51.024483, lon: 3.695193, capacity: 146, available: 131, updated: "2026-11-22T19:25:59+01:00" },
  { slug: "ramen", name: "Ramen", lat: 51.05532, lon: 3.71653, capacity: 227, available: 112, updated: "2026-11-22T19:26:31+01:00" },
  { slug: "reep", name: "Reep", lat: 51.052158, lon: 3.729893, capacity: 455, available: 259, updated: "2026-11-22T19:25:59+01:00" },
  { slug: "savaan", name: "Savaan", lat: 51.048774, lon: 3.723463, capacity: 490, available: 358, updated: "2026-11-22T19:25:59+01:00" },
  { slug: "sint-michiels", name: "Sint-Michiels", lat: 51.05311, lon: 3.719728, capacity: 451, available: 254, updated: "2026-11-22T19:25:59+01:00" },
  { slug: "sint-pietersplein", name: "Sint-Pietersplein", lat: 51.042028, lon: 3.725982, capacity: 700, available: 436, updated: "2026-11-22T19:26:31+01:00" },
  { slug: "the-loop", name: "The Loop", lat: 51.025423, lon: 3.686459, capacity: 2490, available: 2489, updated: "2026-11-22T19:26:00+01:00" },
  { slug: "the-loop-parking-d", name: "The Loop - Parking D", lat: 51.028362, lon: 3.695199, capacity: 177, available: 174, updated: "2026-11-22T19:26:00+01:00" },
  { slug: "tolhuis", name: "Tolhuis", lat: 51.063702, lon: 3.724968, capacity: 149, available: 65, updated: "2026-11-22T19:26:31+01:00" },
  { slug: "vrijdagmarkt", name: "Vrijdagmarkt", lat: 51.057134, lon: 3.726072, capacity: 602, available: 248, updated: "2026-11-22T19:26:31+01:00" },
]

const BIKES: BikeStationState[] = [
  { operator: "donkey", id: "12007", name: "Lange Kruisstraat 4", lat: 51.052857, lon: 3.725929, available: 0 },
  { operator: "donkey", id: "22589", name: "Belfortstraat 18", lat: 51.055301, lon: 3.726792, available: 2 },
  { operator: "donkey", id: "21333", name: "Volderstraat b&b hotel", lat: 51.052201, lon: 3.722234, available: 1 },
  { operator: "donkey", id: "12018", name: "Jan van Stopenberghestraat 2", lat: 51.053549, lon: 3.721223, available: 3 },
  { operator: "donkey", id: "34466", name: "Kammerstraat", lat: 51.055869, lon: 3.727008, available: 7 },
  { operator: "donkey", id: "12023", name: "Groentenmarkt", lat: 51.055762, lon: 3.722004, available: 2 },
  { operator: "donkey", id: "13295", name: "Vrijdagsmarkt 36", lat: 51.056686, lon: 3.726083, available: 0 },
  { operator: "donkey", id: "16698", name: "Kouter 175 GF25!", lat: 51.050446, lon: 3.724784, available: 1 },
  { operator: "donkey", id: "12034", name: "Sint-Michielsplein 16", lat: 51.053869, lon: 3.718968, available: 8 },
  { operator: "donkey", id: "12201", name: "Sint-Veerleplein 4c", lat: 51.056763, lon: 3.721325, available: 0 },
  { operator: "donkey", id: "12024", name: "Drabstraat 12", lat: 51.055344, lon: 3.719255, available: 1 },
  { operator: "donkey", id: "12037", name: "Kraanlei 71 GF26", lat: 51.05761, lon: 3.723744, available: 0 },
  { operator: "donkey", id: "12028", name: "Bibliotheekstraat 1", lat: 51.057107, lon: 3.728648, available: 1 },
  { operator: "donkey", id: "33612", name: "Watergraafstraat", lat: 51.052996, lon: 3.717862, available: 1 },
  { operator: "donkey", id: "32268", name: "Poel 18", lat: 51.054833, lon: 3.717845, available: 2 },
  { operator: "donkey", id: "22603", name: "Savaanstraat 47", lat: 51.048941, lon: 3.726695, available: 12 },
  { operator: "donkey", id: "12200", name: "Recollettenlei 16", lat: 51.049918, lon: 3.719584, available: 1 },
  { operator: "donkey", id: "32116", name: "Geldmunt - sint magrietstraat GF26", lat: 51.058481, lon: 3.720906, available: 2 },
  { operator: "donkey", id: "24168", name: "Oudburg 55", lat: 51.059139, lon: 3.724846, available: 1 },
  { operator: "donkey", id: "13400", name: "Oude Houtlei 124", lat: 51.051273, lon: 3.71699, available: 1 },
  { operator: "donkey", id: "15151", name: "-1 De Krook (underground)", lat: 51.048445, lon: 3.72872, available: 1 },
  { operator: "donkey", id: "12063", name: "Abrahamstraat", lat: 51.057229, lon: 3.717237, available: 1 },
]

// The car-free core first, then the sectors around it.
const SECTORS = ["Kuip", "Coupure", "Tolhuis", "Portus Ganda", "Krook", "Rabot", "Brugse Poort"]

export const FIXTURE_CITY_STATE: CityState = {
  time: "2026-11-22T18:26:31Z",
  garages: GARAGES,
  bikes: BIKES,
  sectors: SECTORS,
  places: [...PLACES],
}

// The same snapshot whatever the mode and time: fixture mode is the point, and until
// T9 wires the live provider the panel says which data time it answered for.
export const fixtureCityState: CityStateProvider = {
  async current() {
    return FIXTURE_CITY_STATE
  },
}
