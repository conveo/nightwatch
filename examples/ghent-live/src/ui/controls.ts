import type { PerspectiveCamera } from "three"
import type { MapControls } from "three/addons/controls/MapControls.js"
import type { Layer } from "../layers/types.ts"
import type { Light, ViewState } from "../view-state.ts"
import { mountLabels, type Rect } from "./labels.ts"
import {
  PRESETS,
  applyPreset,
  flightMs,
  flyFrame,
  matchPreset,
  poseDistance,
  toggleLayer,
  type CameraPose,
  type PresetId,
} from "./presets.ts"
import "./ui.css"

export type ControlsContext = {
  camera: PerspectiveCamera
  controls: MapControls
  layers: Layer[]
  getView: () => ViewState
  // Applies a new view and writes it to the URL.
  setView: (next: ViewState) => void
}

// Names for the layer switches; a layer without one shows its id.
const LAYER_NAMES: Readonly<Record<string, string>> = {
  ground: "Ground and water",
  circulation: "Circulation",
  buildings: "Buildings",
  lichtplan: "Lichtplan",
  parking: "Parking",
  bikes: "Shared bikes",
  origin: "Belfry marker",
}

function button(text: string, className: string): HTMLButtonElement {
  const b = document.createElement("button")
  b.type = "button"
  b.className = className
  b.textContent = text
  return b
}

// Writes the attribute only when it changes: refresh() runs on every camera move.
function setAttr(el: HTMLElement, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

// Camera presets with a fly-to, landmark labels (src/places.ts), layer switches and
// the day/night switch. Owned by ticket T8 in plan/PLAN.md. Everything is a plain
// button, so a tap works like a click. The presets run along the bottom; the switches
// sit on the left under the title; the right side is the "Ask Ghent" panel's.
export function mountControls(root: HTMLElement, ctx: ControlsContext): void {
  const { camera, controls } = ctx
  root.setAttribute("aria-label", "View controls")

  // The view with the live camera: the URL follows a moving camera with a short
  // delay, and a switch flipped mid-flight must not snap the camera back.
  const current = (): ViewState => ({ ...ctx.getView(), cam: camera.position.toArray(), tgt: controls.target.toArray() })

  // --- Presets: a smooth flight, then the preset's exact view in the URL.
  const bar = document.createElement("div")
  bar.className = "ui-presets"
  bar.setAttribute("role", "toolbar")
  bar.setAttribute("aria-label", "Camera presets")
  const presetButtons = new Map<PresetId, HTMLButtonElement>()
  for (const preset of PRESETS) {
    const b = button(preset.name, "ui-button")
    b.dataset.preset = preset.id
    b.addEventListener("click", () => flyTo(preset))
    presetButtons.set(preset.id, b)
    bar.append(b)
  }

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")
  let flight: { raf: number; damping: boolean } | null = null

  function endFlight(): void {
    if (flight == null) return
    cancelAnimationFrame(flight.raf)
    controls.enableDamping = flight.damping
    flight = null
  }

  function flyTo(to: CameraPose): void {
    endFlight()
    const from: CameraPose = { cam: camera.position.toArray(), tgt: controls.target.toArray() }
    if (reducedMotion?.matches === true || poseDistance(from, to) < 0.5) {
      ctx.setView(applyPreset(current(), to))
      refresh()
      return
    }
    // Without damping, update() drops whatever glide a drag left behind, so it cannot
    // push the camera off the flight path; the damping comes back when the flight ends.
    const state = { raf: 0, damping: controls.enableDamping }
    controls.enableDamping = false
    controls.update()
    flight = state
    const ms = flightMs(from, to)
    const start = performance.now()
    const step = (now: number): void => {
      const t = (now - start) / ms
      if (t >= 1) {
        endFlight()
        ctx.setView(applyPreset(current(), to))
        refresh()
        return
      }
      const pose = flyFrame(from, to, t)
      camera.position.set(...pose.cam)
      controls.target.set(...pose.tgt)
      controls.update()
      state.raf = requestAnimationFrame(step)
    }
    state.raf = requestAnimationFrame(step)
  }
  // A person grabbing the camera, or a link to another view, takes over from a flight.
  controls.addEventListener("start", endFlight)
  window.addEventListener("hashchange", endFlight)

  // --- Day/night and the layers, on the left under the title.
  const panel = document.createElement("div")
  panel.className = "ui-panel"

  const lightGroup = document.createElement("div")
  lightGroup.className = "ui-light"
  lightGroup.setAttribute("role", "group")
  lightGroup.setAttribute("aria-label", "Lighting")
  const lightButtons = new Map<Light, HTMLButtonElement>()
  for (const [light, name] of [
    ["day", "Day"],
    ["night", "Night"],
  ] as const) {
    const b = button(name, "ui-button ui-segment")
    b.addEventListener("click", () => {
      ctx.setView({ ...current(), light })
      refresh()
    })
    lightButtons.set(light, b)
    lightGroup.append(b)
  }

  // The layer list folds away, for a phone held upright.
  const layersHeading = button("Layers", "ui-button ui-disclosure")
  const layerList = document.createElement("div")
  layerList.id = "ui-layer-list"
  layerList.className = "ui-layers"
  layersHeading.setAttribute("aria-controls", layerList.id)
  const showLayers = (open: boolean): void => {
    layersHeading.setAttribute("aria-expanded", String(open))
    layerList.hidden = !open
  }
  showLayers(window.innerWidth >= 700)
  layersHeading.addEventListener("click", () => showLayers(layersHeading.getAttribute("aria-expanded") !== "true"))
  layerList.setAttribute("role", "group")
  layerList.setAttribute("aria-label", "Layers")
  const allLayers = ctx.layers.map((l) => l.id)
  const layerButtons = new Map<string, HTMLButtonElement>()
  for (const id of allLayers) {
    const b = button(LAYER_NAMES[id] ?? id, "ui-button ui-toggle")
    b.addEventListener("click", () => {
      ctx.setView({ ...current(), layers: toggleLayer(ctx.getView().layers, allLayers, id) })
      refresh()
    })
    layerButtons.set(id, b)
    layerList.append(b)
  }
  panel.append(lightGroup, layersHeading, layerList)
  root.append(panel, bar)

  // The title's box grows when the status line shows, so the panel follows its bottom.
  const hud = document.querySelector<HTMLElement>("#hud")
  const placePanel = (): void => {
    const top = Math.round((hud?.getBoundingClientRect().bottom ?? 0) + 12)
    panel.style.top = `${top}px`
    // Room for the preset bar below.
    panel.style.maxHeight = `calc(100vh - ${top + 140}px)`
  }
  placePanel()
  if (hud != null && typeof ResizeObserver !== "undefined") new ResizeObserver(placePanel).observe(hud)
  window.addEventListener("resize", placePanel)

  // --- Labels keep clear of the title, the panels and the footer. Their boxes are
  // read twice a second, not every frame.
  let obstacles: Rect[] = []
  const blockers = [hud, document.querySelector<HTMLElement>("#ask"), panel, bar, document.querySelector<HTMLElement>("#attribution")]
  const measureObstacles = (): void => {
    obstacles = blockers.flatMap((el) => {
      if (el == null || el.hidden) return []
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 ? [{ x: r.left, y: r.top, w: r.width, h: r.height }] : []
    })
  }
  measureObstacles()
  setInterval(measureObstacles, 500)
  window.addEventListener("resize", measureObstacles)

  mountLabels(root, {
    camera,
    obstacles: () => obstacles,
    selected: () => ctx.getView().sel,
    onSelect: (slug) => ctx.setView({ ...current(), sel: `place:${slug}` }),
  })

  // --- The buttons show the view as it is, however it changed (a click here, a drag,
  // an edited URL).
  function refresh(): void {
    const view = ctx.getView()
    const at = flight == null ? matchPreset({ cam: camera.position.toArray(), tgt: controls.target.toArray() }) : null
    for (const [id, b] of presetButtons) setAttr(b, "aria-pressed", String(id === at))
    for (const [light, b] of lightButtons) setAttr(b, "aria-pressed", String(view.light === light))
    for (const [id, b] of layerButtons) setAttr(b, "aria-pressed", String(view.layers == null || view.layers.includes(id)))
  }
  refresh()
  controls.addEventListener("end", refresh)
  controls.addEventListener("change", () => {
    if (flight == null) refresh()
  })
  window.addEventListener("hashchange", refresh)
}
