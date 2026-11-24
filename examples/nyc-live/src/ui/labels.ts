import { Vector3, type Camera } from "three"
import type { Vec3 } from "../view-state.ts"
import { at } from "./camera.ts"

// Place names drawn over the scene. Each label is an HTML element at 24px or more
// (readable on a projector), placed every frame at its point's position on screen.

export type PlaceKind = "venue" | "landmark" | "neighbourhood"
export type Place = { id: string; name: string; kind: PlaceKind; at: Vec3 }

// Labels float above the street so buildings in front do not swallow the anchor.
const LABEL_HEIGHT_M = 30

function landmark(id: string, name: string, lat: number, lon: number): Place {
  return { id, name, kind: "landmark", at: at(lat, lon, LABEL_HEIGHT_M) }
}

function neighbourhood(id: string, name: string, lat: number, lon: number): Place {
  return { id, name, kind: "neighbourhood", at: at(lat, lon, LABEL_HEIGHT_M) }
}

// In priority order: when two labels overlap on screen, the earlier one stays.
export const PLACES: readonly Place[] = [
  // On the top of the venue's pin (80 m, see layers/venue.ts).
  { id: "venue", name: "598 Broadway", kind: "venue", at: [0, 80, 0] },
  landmark("battery-park", "Battery Park", 40.7036, -74.0164),
  landmark("brooklyn-bridge", "Brooklyn Bridge", 40.7057, -73.9958),
  landmark("world-trade-center", "World Trade Center", 40.7127, -74.0134),
  neighbourhood("soho", "SoHo", 40.723, -74.002),
  neighbourhood("financial-district", "Financial District", 40.7075, -74.0113),
  neighbourhood("chinatown", "Chinatown", 40.7158, -73.997),
  neighbourhood("tribeca", "Tribeca", 40.7163, -74.0086),
  neighbourhood("greenwich-village", "Greenwich Village", 40.732, -73.999),
  neighbourhood("east-village", "East Village", 40.7265, -73.9815),
  neighbourhood("lower-east-side", "Lower East Side", 40.715, -73.9843),
  neighbourhood("noho", "NoHo", 40.7275, -73.9935),
  neighbourhood("little-italy", "Little Italy", 40.7191, -73.9973),
  neighbourhood("west-village", "West Village", 40.735, -74.005),
  neighbourhood("battery-park-city", "Battery Park City", 40.7116, -74.0158),
  neighbourhood("union-square", "Union Square", 40.7359, -73.9906),
  neighbourhood("gramercy", "Gramercy", 40.7368, -73.9845),
  neighbourhood("dumbo", "DUMBO", 40.7033, -73.9881),
]

// The venue's marker (layers/venue.ts): the head of its 80 m pin and the 20 m ring at
// its foot. Its label stands above all of it on screen, so from any angle, straight
// down included, the label covers neither the pin nor the ring.
const RING_RADIUS_M = 20
export const VENUE_MARKER: readonly Vec3[] = [
  [0, 80, 0],
  ...Array.from({ length: 8 }, (_, i): Vec3 => {
    const a = (i * Math.PI) / 4
    return [RING_RADIUS_M * Math.cos(a), 0.5, RING_RADIUS_M * Math.sin(a)]
  }),
]

const marker = new Vector3()

// How far down the screen (px) the venue's marker reaches its highest point, for a
// screen `height` px tall; null when none of it is in front of the camera.
export function venueMarkerTop(camera: Camera, height: number): number | null {
  let top: number | null = null
  for (const p of VENUE_MARKER) {
    marker.set(...p).project(camera)
    if (marker.z < -1 || marker.z > 1) continue
    const y = ((1 - marker.y) / 2) * height
    top = top == null ? y : Math.min(top, y)
  }
  return top
}

export type Rect = { left: number; top: number; width: number; height: number }
export type LabelBox = Rect & { id: string }

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.left < b.left + b.width + gap &&
    b.left < a.left + a.width + gap &&
    a.top < b.top + b.height + gap &&
    b.top < a.top + a.height + gap
  )
}

// Which labels to show, given their boxes on screen in priority order: each label
// must fit inside the viewport and clear the on-screen panels (`blocked`) and every
// label already kept. Returns the ids kept, in order.
export function placeLabels(
  boxes: readonly LabelBox[],
  viewport: { width: number; height: number },
  blocked: readonly Rect[] = [],
  gap = 8,
): string[] {
  const taken: Rect[] = [...blocked]
  const kept: string[] = []
  for (const box of boxes) {
    const inside = box.left >= 0 && box.top >= 0 && box.left + box.width <= viewport.width && box.top + box.height <= viewport.height
    if (!inside || taken.some((r) => overlaps(box, r, gap))) continue
    taken.push(box)
    kept.push(box.id)
  }
  return kept
}
