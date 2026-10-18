import { AREA } from "../constants.ts"
import { MANHATTAN_GRID_ROTATION_DEG, toLocal } from "../geo.ts"
import { DEFAULT_VIEW, type Vec3 } from "../view-state.ts"

// Camera presets and the maths of flying between them. No DOM and no three.js, so
// the unit tests run it directly.

const DEG = Math.PI / 180

// A camera described by the point it looks at. Pitch is degrees above the horizon
// (90 looks straight down); heading is the compass bearing the camera faces (0
// north, 90 east). Scene axes as in geo.ts: x east, y up, z south.
export type Pose = { target: Vec3; distance: number; pitch: number; heading: number }

// What the URL stores: the camera position and its target.
export type CameraView = { cam: Vec3; tgt: Vec3 }

export function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360
}

// The signed turn from one heading to another the short way round, in [-180, 180).
export function turn(from: number, to: number): number {
  return normalizeDegrees(to - from + 180) - 180
}

export function poseToView(pose: Pose): CameraView {
  const [tx, ty, tz] = pose.target
  const flat = pose.distance * Math.cos(pose.pitch * DEG)
  return {
    cam: [
      tx - flat * Math.sin(pose.heading * DEG),
      ty + pose.distance * Math.sin(pose.pitch * DEG),
      tz + flat * Math.cos(pose.heading * DEG),
    ],
    tgt: [tx, ty, tz],
  }
}

export function viewToPose(view: CameraView): Pose {
  const dx = view.cam[0] - view.tgt[0]
  const dy = view.cam[1] - view.tgt[1]
  const dz = view.cam[2] - view.tgt[2]
  const distance = Math.hypot(dx, dy, dz)
  return {
    target: [...view.tgt],
    distance,
    pitch: distance === 0 ? 90 : Math.asin(dy / distance) / DEG,
    heading: normalizeDegrees(Math.atan2(-dx, dz) / DEG),
  }
}

// The URL keeps 0.1 m (see serializeViewState); presets use the same precision, so
// a preset survives a round trip through the URL unchanged.
function round(n: number): number {
  return Math.round(n * 10) / 10
}

export function roundView(view: CameraView): CameraView {
  return { cam: [round(view.cam[0]), round(view.cam[1]), round(view.cam[2])], tgt: [round(view.tgt[0]), round(view.tgt[1]), round(view.tgt[2])] }
}

export function at(lat: number, lon: number, y = 0): Vec3 {
  const p = toLocal({ lat, lon })
  return [p.x, y, p.z]
}

// Moves a point relative to a heading: forward along it, right across it.
export function offset(point: Vec3, heading: number, forward: number, right: number): Vec3 {
  const s = Math.sin(heading * DEG)
  const c = Math.cos(heading * DEG)
  return [point[0] + forward * s + right * c, point[1], point[2] - forward * c + right * s]
}

export type PresetId = "venue" | "battery" | "brooklyn-bridge" | "above" | "street"
export type Preset = { id: PresetId; label: string; view: CameraView }

// Broadway runs a few degrees east of the street grid as it passes the venue.
const BROADWAY_HEADING_DEG = 32

export const PRESETS: readonly Preset[] = [
  // The view the app opens on.
  { id: "venue", label: "Venue", view: { cam: [...DEFAULT_VIEW.cam], tgt: [...DEFAULT_VIEW.tgt] } },
  // From over the harbour, looking up the island along the avenues.
  {
    id: "battery",
    label: "Battery",
    view: roundView(poseToView({ target: at(40.7036, -74.0164), distance: 1500, pitch: 30, heading: MANHATTAN_GRID_ROTATION_DEG })),
  },
  // Side on, from downstream on the East River, with Manhattan on the left.
  {
    id: "brooklyn-bridge",
    label: "Brooklyn Bridge",
    view: roundView(poseToView({ target: at(40.7057, -73.9958), distance: 1200, pitch: 18, heading: 36 })),
  },
  // Nearly straight down on the whole island, from the Battery (left) to Union
  // Square (right), as seen from Brooklyn: the island is longer than it is wide, so
  // it runs along the width of a 16:9 screen.
  {
    id: "above",
    label: "From above",
    view: roundView(
      poseToView({
        target: offset(at((AREA.south + AREA.north) / 2, (AREA.west + AREA.east) / 2), MANHATTAN_GRID_ROTATION_DEG, -350, 0),
        distance: 3500,
        pitch: 88,
        heading: normalizeDegrees(MANHATTAN_GRID_ROTATION_DEG - 90),
      }),
    ),
  },
  // Eye height on Broadway, 300 m south of the venue, looking north at it. The
  // venue's building is on the east side of Broadway, so the street is to its west.
  {
    id: "street",
    label: "Street level",
    view: roundView(
      poseToView({ target: offset([0, 0, 0], BROADWAY_HEADING_DEG, -150, -25), distance: 150, pitch: 3, heading: BROADWAY_HEADING_DEG }),
    ),
  },
]

function near(a: Vec3, b: Vec3, tolerance: number): boolean {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance && Math.abs(a[2] - b[2]) <= tolerance
}

// The preset the camera is on, if any.
export function activePreset(view: CameraView, presets: readonly Preset[] = PRESETS, tolerance = 1): Preset | null {
  return presets.find((p) => near(p.view.cam, view.cam, tolerance) && near(p.view.tgt, view.tgt, tolerance)) ?? null
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function travel(from: Pose, to: Pose): number {
  return Math.hypot(to.target[0] - from.target[0], to.target[2] - from.target[2])
}

// How far the camera rises on a long flight, as a fraction of its distance.
const MAX_HOP = 1.5

// The pose at time t (0 to 1) of a flight. The target slides across, the distance
// changes by the same ratio every step (so zooming feels even), the heading turns
// the short way round, and on a long flight the camera rises midway so the ground
// it crosses stays in view.
export function interpolatePose(from: Pose, to: Pose, t: number): Pose {
  const e = easeInOutCubic(clamp(t, 0, 1))
  const d0 = Math.max(1, from.distance)
  const d1 = Math.max(1, to.distance)
  const hop = Math.min(MAX_HOP, travel(from, to) / (2 * Math.max(d0, d1)))
  return {
    target: [
      from.target[0] + (to.target[0] - from.target[0]) * e,
      from.target[1] + (to.target[1] - from.target[1]) * e,
      from.target[2] + (to.target[2] - from.target[2]) * e,
    ],
    distance: d0 ** (1 - e) * d1 ** e * (1 + hop * Math.sin(Math.PI * e)),
    pitch: from.pitch + (to.pitch - from.pitch) * e,
    heading: normalizeDegrees(from.heading + turn(from.heading, to.heading) * e),
  }
}

export const MIN_FLIGHT_MS = 700
export const MAX_FLIGHT_MS = 2400

// Longer flights take longer, but never so long that a presenter waits on them.
export function flightMs(from: Pose, to: Pose): number {
  const zoom = Math.abs(Math.log2(Math.max(1, to.distance) / Math.max(1, from.distance)))
  const turning = Math.abs(turn(from.heading, to.heading))
  const ms = MIN_FLIGHT_MS + 250 * Math.log2(1 + travel(from, to) / 200) + 150 * zoom + 2 * turning
  return Math.round(clamp(ms, MIN_FLIGHT_MS, MAX_FLIGHT_MS))
}
