import { toLocal } from "../geo.ts"
import { placeBySlug } from "../places.ts"
import type { Vec3, ViewState } from "../view-state.ts"

// Camera presets and the maths of flying between them. No DOM and no three.js here,
// so the tests run it directly; controls.ts does the drawing and the animation.
//
// Scene coordinates are metres from the Belfry: x east, y up, z south (src/geo.ts).

export type CameraPose = { cam: Vec3; tgt: Vec3 }
export type PresetId = "belfort" | "graslei" | "gravensteen" | "sint-baafs" | "above" | "street"
export type Preset = CameraPose & { id: PresetId; name: string }

const DEG = Math.PI / 180

// The hash keeps 0.1 m (serializeViewState), so presets are rounded to that already
// and survive a round trip through the URL unchanged.
function round1(n: number): number {
  // `|| 0` turns -0 into 0, which is what the URL gives back.
  return Math.round(n * 10) / 10 || 0
}

function rounded(v: Vec3): Vec3 {
  return [round1(v[0]), round1(v[1]), round1(v[2])]
}

// The horizontal direction of a compass heading (0 = north, 90 = east) in scene axes.
function direction(headingDeg: number): { x: number; z: number } {
  return { x: Math.sin(headingDeg * DEG), z: -Math.cos(headingDeg * DEG) }
}

function placeAt(slug: string, y = 0): Vec3 {
  const place = placeBySlug(slug)
  if (place == null) throw new Error(`unknown place ${slug}`)
  const { x, z } = toLocal(place)
  return [x, y, z]
}

// A view of `tgt` from `distance` metres away (horizontally) and `height` metres above
// it, looking along `headingDeg`.
export function poseLookingAt(tgt: Vec3, headingDeg: number, distance: number, height: number): CameraPose {
  const d = direction(headingDeg)
  return {
    cam: rounded([tgt[0] - d.x * distance, tgt[1] + height, tgt[2] - d.z * distance]),
    tgt: rounded(tgt),
  }
}

// A person standing at `eye`, looking along `headingDeg` and `pitchDownDeg` below the
// horizon. The target is the point `distance` metres ahead on that line, which is
// also what the camera orbits around afterwards.
export function poseFromEye(eye: Vec3, headingDeg: number, pitchDownDeg: number, distance: number): CameraPose {
  const d = direction(headingDeg)
  const ahead = distance * Math.cos(pitchDownDeg * DEG)
  const drop = distance * Math.sin(pitchDownDeg * DEG)
  return {
    cam: rounded(eye),
    tgt: rounded([eye[0] + d.x * ahead, eye[1] - drop, eye[2] + d.z * ahead]),
  }
}

// MapControls in main.ts keeps the camera at least this far from straight overhead of
// its target (maxPolarAngle = PI / 2.05): every view looks at least ~2.2° down. A
// preset that broke this would be moved by the controls and lose its round trip.
export const MAX_POLAR_ANGLE = Math.PI / 2.05

// The compass heading from one point to another (0 = north, 90 = east).
export function headingTo(from: Vec3, to: Vec3): number {
  const h = Math.atan2(to[0] - from[0], -(to[2] - from[2])) / DEG
  return (h + 360) % 360
}

const bridge = placeAt("sint-michielsbrug")
// The eye: on the bridge's deck, 6 m above the street, by its north parapet.
const streetEye: Vec3 = [bridge[0] + 0.9, 6, bridge[2] - 7.3]

export const PRESETS: readonly Preset[] = [
  { id: "belfort", name: "Belfort", ...poseLookingAt(placeAt("belfort", 40), 40, 330, 190) },
  { id: "graslei", name: "Graslei", ...poseLookingAt(placeAt("graslei", 8), 35, 230, 95) },
  // The castle gate faces east, onto the Sint-Veerleplein.
  { id: "gravensteen", name: "Gravensteen", ...poseLookingAt(placeAt("gravensteen", 12), 300, 250, 130) },
  { id: "sint-baafs", name: "Sint-Baafs", ...poseLookingAt(placeAt("sint-baafs", 35), 335, 300, 160) },
  // The landmarks lie north-west of the Belfry, so the view centres on them, slightly
  // tilted so the buildings still read as 3D.
  { id: "above", name: "From above", ...poseLookingAt([-100, 0, -140], 0, 200, 850) },
  // On the Sint-Michielsbrug at eye height, looking east along the Korenmarkt: the
  // towers of Sint-Niklaas, the Belfry and Sint-Baafs stand in a row. From the north
  // side of the bridge, Sint-Baafs shows past the Korenmarkt's south corner.
  { id: "street", name: "Street level", ...poseFromEye(streetEye, headingTo(streetEye, placeAt("belfort")) + 1.5, 2.4, 80) },
]

export function presetById(id: string): Preset | null {
  return PRESETS.find((p) => p.id === id) ?? null
}

// A preset changes the camera only: everything else in the view stays as it was.
export function applyPreset(view: ViewState, preset: CameraPose): ViewState {
  return { ...view, cam: [...preset.cam], tgt: [...preset.tgt] }
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

// How far apart two views are: the larger of the camera's and the target's moves.
export function poseDistance(a: CameraPose, b: CameraPose): number {
  return Math.max(distance(a.cam, b.cam), distance(a.tgt, b.tgt))
}

// The preset the view is at, if any: the button that shows as current.
export function matchPreset(view: CameraPose, toleranceM = 0.5): PresetId | null {
  const hit = PRESETS.find((p) => poseDistance(p, view) <= toleranceM)
  return hit?.id ?? null
}

// The angle between the camera's view and straight down from overhead, as MapControls
// measures it (0 = looking straight down, PI / 2 = looking at the horizon).
export function polarAngle(pose: CameraPose): number {
  const dx = pose.cam[0] - pose.tgt[0]
  const dy = pose.cam[1] - pose.tgt[1]
  const dz = pose.cam[2] - pose.tgt[2]
  return Math.acos(Math.max(-1, Math.min(1, dy / Math.hypot(dx, dy, dz))))
}

export function easeInOutCubic(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2
}

// How long a flight takes: longer for longer trips, never so short it jumps nor so
// long a presenter waits.
export function flightMs(from: CameraPose, to: CameraPose): number {
  return Math.round(Math.min(2400, 800 + poseDistance(from, to) * 0.9))
}

// The camera at time `t` (0..1) of a flight. Camera and target glide with an
// ease-in-out, and the camera rises on an arc over long trips, so a flight between
// two low views passes over the roofs rather than through them.
export function flyFrame(from: CameraPose, to: CameraPose, t: number): CameraPose {
  if (t >= 1) return { cam: [...to.cam], tgt: [...to.tgt] }
  const e = easeInOutCubic(t)
  const lerp = (a: Vec3, b: Vec3): Vec3 => [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e]
  const across = Math.hypot(to.cam[0] - from.cam[0], to.cam[2] - from.cam[2])
  const lift = Math.min(0.35 * across, 500) * 4 * e * (1 - e)
  const cam = lerp(from.cam, to.cam)
  return { cam: [cam[0], cam[1] + lift, cam[2]], tgt: lerp(from.tgt, to.tgt) }
}

// Turning one layer on or off. `null` means every layer is shown (no `layers` in the
// URL); a list keeps the order of `all`, and a list with every layer becomes null again.
export function toggleLayer(visible: readonly string[] | null, all: readonly string[], id: string): string[] | null {
  const shown = new Set(visible ?? all)
  if (shown.has(id)) shown.delete(id)
  else shown.add(id)
  const next = all.filter((l) => shown.has(l))
  return next.length === all.length ? null : next
}
