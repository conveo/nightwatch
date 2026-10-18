import type { PerspectiveCamera } from "three"
import type { MapControls } from "three/addons/controls/MapControls.js"
import type { Layer } from "../layers/types.ts"
import type { ViewState } from "../view-state.ts"

export type ControlsContext = {
  camera: PerspectiveCamera
  controls: MapControls
  layers: Layer[]
  getView: () => ViewState
  // Applies a new view and writes it to the URL.
  setView: (next: ViewState) => void
}

// Camera presets with fly-to, labels, layer toggles and the day/night switch.
// Owned by ticket T7 in plan/PLAN.md. Until then there are no on-screen controls.
export function mountControls(_root: HTMLElement, _ctx: ControlsContext): void {}
