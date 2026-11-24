import { Vector3, type PerspectiveCamera } from "three"
import type { MapControls } from "three/addons/controls/MapControls.js"
import type { Layer } from "../layers/types.ts"
import type { Light, ViewState } from "../view-state.ts"
import { activePreset, flightMs, interpolatePose, poseToView, PRESETS, viewToPose, type CameraView, type Preset } from "./camera.ts"
import { PLACES, placeLabels, venueMarkerTop, type LabelBox, type Place, type Rect } from "./labels.ts"
import { isLayerShown, layerName, toggleLayer } from "./layers.ts"
import "./controls.css"

export type ControlsContext = {
  camera: PerspectiveCamera
  controls: MapControls
  layers: Layer[]
  getView: () => ViewState
  // Applies a new view and writes it to the URL.
  setView: (next: ViewState) => void
}

// Labels further than this from the camera are lost in the fog (main.ts fades the
// scene out between 2,500 and 6,000 m).
const MAX_LABEL_DISTANCE_M = 5000

// The venue's label stands on its marker with a pointer this tall (see controls.css).
const VENUE_POINTER_PX = 12

// On-screen panels that labels must not cover.
const PANELS = ["#hud", "#ask", "#attribution"]

const LIGHTS: Array<{ light: Light; label: string }> = [
  { light: "day", label: "☀ Day" },
  { light: "night", label: "☾ Night" },
]

function button(label: string, className: string, onPress: () => void): HTMLButtonElement {
  const b = document.createElement("button")
  b.type = "button"
  b.className = className
  b.textContent = label
  b.setAttribute("aria-pressed", "false")
  b.addEventListener("click", onPress)
  return b
}

function group(label: string, buttons: HTMLButtonElement[]): HTMLElement {
  const g = document.createElement("div")
  g.className = "nyc-group"
  g.setAttribute("role", "group")
  g.setAttribute("aria-label", label)
  g.append(...buttons)
  return g
}

function press(b: HTMLButtonElement | undefined, pressed: boolean): void {
  b?.setAttribute("aria-pressed", String(pressed))
}

// Camera presets with a smooth fly-to, layer toggles, the day/night switch and the
// place labels. Every control is a plain button (at least 48px tall, so a finger
// can hit it) that changes the view through setView, so the URL always describes
// what is on screen.
export function mountControls(root: HTMLElement, ctx: ControlsContext): void {
  const { camera, controls } = ctx
  const layerIds = ctx.layers.map((l) => l.id)
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

  const current = (): CameraView => ({ cam: camera.position.toArray(), tgt: controls.target.toArray() })

  // Every change keeps the camera where it is now: the view's own copy is only
  // brought up to date once a drag has settled.
  function update(patch: Partial<ViewState>): void {
    ctx.setView({ ...ctx.getView(), ...current(), ...patch })
    refresh()
  }

  // Fly-to: one animation frame per step, cancelled by any input on the map.
  let flight = 0
  let destination: Preset | null = null

  // A flight stopped midway leaves the camera between presets, and nothing else
  // moves it, so the highlight is brought up to date here.
  function stopFlight(): void {
    if (flight !== 0) cancelAnimationFrame(flight)
    flight = 0
    destination = null
    refreshPreset()
  }

  function flyTo(preset: Preset): void {
    stopFlight()
    destination = preset
    refreshPreset()
    const from = viewToPose(current())
    const to = viewToPose(preset.view)
    const ms = reducedMotion.matches ? 0 : flightMs(from, to)
    const start = performance.now()
    const step = (now: number): void => {
      const t = ms === 0 ? 1 : (now - start) / ms
      if (t >= 1) {
        flight = 0
        destination = null
        update({ ...preset.view })
        return
      }
      const { cam, tgt } = poseToView(interpolatePose(from, to, t))
      camera.position.set(...cam)
      controls.target.set(...tgt)
      flight = requestAnimationFrame(step)
    }
    flight = requestAnimationFrame(step)
  }

  const presetButtons = new Map(PRESETS.map((p) => [p.id, button(p.label, "nyc-btn nyc-preset", () => flyTo(p))]))
  const layerButtons = new Map(
    layerIds.map((id) => [
      id,
      button(layerName(id), "nyc-btn nyc-toggle", () => update({ layers: toggleLayer(ctx.getView().layers, layerIds, id) })),
    ]),
  )
  const lightButtons = new Map(LIGHTS.map(({ light, label }) => [light, button(label, `nyc-btn nyc-light nyc-light--${light}`, () => update({ light }))]))

  const presetRow = document.createElement("div")
  presetRow.className = "nyc-row"
  presetRow.append(group("Camera presets", [...presetButtons.values()]), group("Day or night", [...lightButtons.values()]))
  const layerRow = document.createElement("div")
  layerRow.className = "nyc-row"
  layerRow.append(group("Layers", [...layerButtons.values()]))
  root.classList.add("nyc-controls")
  root.setAttribute("aria-label", "Map controls")
  root.append(presetRow, layerRow)

  // Labels sit in their own layer above the canvas and below every panel, and never
  // take a pointer, so the map underneath still drags.
  const labelLayer = document.createElement("div")
  labelLayer.className = "nyc-labels"
  labelLayer.setAttribute("aria-hidden", "true")
  document.body.prepend(labelLayer)
  const labels = PLACES.map((place: Place) => {
    const el = document.createElement("div")
    el.className = `nyc-label nyc-label--${place.kind}`
    el.textContent = place.name
    labelLayer.append(el)
    return { place, el, width: 0, height: 0, shown: false }
  })

  function measure(): void {
    for (const l of labels) {
      l.width = l.el.offsetWidth
      l.height = l.el.offsetHeight
    }
  }

  const panels = [root, ...PANELS.map((s) => document.querySelector<HTMLElement>(s))].filter((el) => el != null)
  function blockedRects(): Rect[] {
    return panels.flatMap((el) => {
      const r = el.getBoundingClientRect()
      return r.width === 0 || r.height === 0 ? [] : [{ left: r.left, top: r.top, width: r.width, height: r.height }]
    })
  }

  const point = new Vector3()
  function updateLabels(): void {
    const width = window.innerWidth
    const height = window.innerHeight
    const venueShown = ctx.layers.find((l) => l.id === "venue")?.group.visible ?? true
    camera.updateMatrixWorld()
    const boxes: LabelBox[] = []
    for (const l of labels) {
      if (l.place.kind === "venue" && !venueShown) continue
      point.set(...l.place.at)
      if (point.distanceTo(camera.position) > MAX_LABEL_DISTANCE_M) continue
      point.project(camera)
      // Outside the depth range means behind the camera or past the far plane.
      if (point.z < -1 || point.z > 1) continue
      const x = ((point.x + 1) / 2) * width
      const y = ((1 - point.y) / 2) * height
      // The venue's label stands on top of its marker, above the pin's head and its
      // ring however the camera looks; the others are centred on their place.
      const top = l.place.kind === "venue" ? (venueMarkerTop(camera, height) ?? y) - l.height - VENUE_POINTER_PX : y - l.height / 2
      boxes.push({ id: l.place.id, left: x - l.width / 2, top, width: l.width, height: l.height })
    }
    const kept = new Set(placeLabels(boxes, { width, height }, blockedRects()))
    const byId = new Map(boxes.map((b) => [b.id, b]))
    for (const l of labels) {
      const box = byId.get(l.place.id)
      const show = box != null && kept.has(l.place.id)
      if (show) l.el.style.transform = `translate(${Math.round(box.left)}px, ${Math.round(box.top)}px)`
      if (show !== l.shown) {
        l.el.classList.toggle("nyc-label--shown", show)
        l.shown = show
      }
    }
  }

  let shownPreset: string | null | undefined
  function refreshPreset(): void {
    const active = destination?.id ?? activePreset(current())?.id ?? null
    if (active === shownPreset) return
    shownPreset = active
    for (const [id, b] of presetButtons) press(b, id === active)
  }

  function refresh(): void {
    const view = ctx.getView()
    for (const [id, b] of layerButtons) press(b, isLayerShown(view.layers, id))
    for (const [light, b] of lightButtons) press(b, view.light === light)
    refreshPreset()
    updateLabels()
  }

  // `change` fires inside the render loop whenever the camera moves, just before the
  // frame is drawn, so the labels move with the scene.
  controls.addEventListener("change", () => {
    refreshPreset()
    updateLabels()
  })
  controls.addEventListener("start", stopFlight)
  window.addEventListener("hashchange", () => {
    stopFlight()
    refresh()
  })
  window.addEventListener("resize", updateLabels)
  // Panels also change size while the camera stands still (the HUD's status line
  // fills in once the layers load, the ask panel opens), so place the labels again.
  const panelSizes = new ResizeObserver(updateLabels)
  for (const el of panels) panelSizes.observe(el)

  measure()
  refresh()
  void document.fonts?.ready.then(() => {
    measure()
    updateLabels()
  })
}
