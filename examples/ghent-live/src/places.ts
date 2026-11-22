import type { LatLon } from "./geo.ts"

// Landmarks that several tickets use: camera presets and labels (T8), the questions
// in "ask Ghent" (T7) and the review plan (T9). Coordinates are from Stad Gent's
// Lichtplan points of interest (data.stad.gent, points-of-interest-poi-lichtplan-gent).
// A selection id for a place is `place:<slug>`.
export type Place = LatLon & { slug: string; nl: string; en: string }

export const PLACES: readonly Place[] = [
  { slug: "belfort", nl: "Belfort en Lakenhalle", en: "Belfry and Cloth Hall", lat: 51.053686, lon: 3.724972 },
  { slug: "sint-baafs", nl: "Sint-Baafskathedraal", en: "St Bavo's Cathedral", lat: 51.053086, lon: 3.726488 },
  { slug: "sint-niklaas", nl: "Sint-Niklaaskerk", en: "St Nicholas' Church", lat: 51.053875, lon: 3.723529 },
  { slug: "sint-michielsbrug", nl: "Sint-Michielsbrug", en: "St Michael's Bridge", lat: 51.053854, lon: 3.720558 },
  { slug: "graslei", nl: "Graslei en Korenlei", en: "Graslei and Korenlei", lat: 51.055473, lon: 3.720518 },
  { slug: "gravensteen", nl: "Gravensteen", en: "Castle of the Counts", lat: 51.057118, lon: 3.720748 },
  { slug: "stadhuis", nl: "Stadhuis", en: "Town Hall", lat: 51.054439, lon: 3.7251 },
  { slug: "vrijdagmarkt", nl: "Vrijdagmarkt", en: "Vrijdagmarkt", lat: 51.057134, lon: 3.726072 },
]

export function placeBySlug(slug: string): Place | null {
  return PLACES.find((p) => p.slug === slug) ?? null
}
