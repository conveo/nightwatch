// Everything needed to reproduce what a person sees lives in the URL hash, so a
// reviewer-overlay note (which carries the page URL) lets an agent open the exact
// view again: camera, target, selection, data mode, data time, visible layers and
// day or night lighting.
//
//   #cam=120,380,520&tgt=0,0,0&sel=bin:1007945&mode=recorded&t=2026-10-21T23:10:00Z&layers=buildings,subway&light=night

export type DataMode = "fixture" | "recorded" | "live"
export type Light = "day" | "night"
export type Vec3 = [number, number, number]

export type ViewState = {
  cam: Vec3
  tgt: Vec3
  sel: string | null
  mode: DataMode
  t: string | null
  layers: string[] | null
  light: Light
}

export const DEFAULT_VIEW: ViewState = {
  cam: [320, 420, 620],
  tgt: [0, 0, 0],
  sel: null,
  mode: "fixture",
  t: null,
  layers: null,
  light: "day",
}

const MODES: readonly DataMode[] = ["fixture", "recorded", "live"]

function parseVec3(raw: string | null): Vec3 | null {
  if (raw == null) return null
  const parts = raw.split(",").map((p) => Number(p))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
  return [parts[0]!, parts[1]!, parts[2]!]
}

function round(n: number): string {
  return String(Math.round(n * 10) / 10)
}

// Unknown or malformed values fall back to the default, so a hand-edited or
// truncated URL still opens a sensible view.
export function parseViewState(hash: string): ViewState {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  const mode = params.get("mode")
  const t = params.get("t")
  const layers = params.get("layers")
  return {
    cam: parseVec3(params.get("cam")) ?? DEFAULT_VIEW.cam,
    tgt: parseVec3(params.get("tgt")) ?? DEFAULT_VIEW.tgt,
    sel: params.get("sel") || null,
    mode: MODES.includes(mode as DataMode) ? (mode as DataMode) : DEFAULT_VIEW.mode,
    t: t != null && !Number.isNaN(Date.parse(t)) ? t : null,
    layers: layers ? layers.split(",").filter((l) => l !== "") : null,
    light: params.get("light") === "night" ? "night" : "day",
  }
}

export function serializeViewState(state: ViewState): string {
  const params = new URLSearchParams()
  params.set("cam", state.cam.map(round).join(","))
  params.set("tgt", state.tgt.map(round).join(","))
  if (state.sel != null) params.set("sel", state.sel)
  params.set("mode", state.mode)
  if (state.t != null) params.set("t", state.t)
  if (state.layers != null) params.set("layers", state.layers.join(","))
  if (state.light === "night") params.set("light", "night")
  // URLSearchParams encodes "," and ":"; keep the hash readable in a note.
  return "#" + params.toString().replaceAll("%2C", ",").replaceAll("%3A", ":")
}
