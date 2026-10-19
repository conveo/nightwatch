import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer,
} from "three"
import { MapControls } from "three/addons/controls/MapControls.js"
import { mountAskPanel } from "./ask/panel.ts"
import { createLayers } from "./layers/index.ts"
import { followCamera } from "./ui/camera.ts"
import { mountControls } from "./ui/controls.ts"
import { parseViewState, serializeViewState, type Light, type Vec3, type ViewState } from "./view-state.ts"
import "./style.css"

declare global {
  interface Window {
    // Read by scripts/shot.ts, which takes its screenshot once `ready` is true. `stats`
    // reports the last frame's draw calls and triangles and the GPU objects held, for
    // checking the cost of everything on at once without a GPU profiler.
    __nycLive?: { ready: boolean; layers: string[]; errors: string[]; view: ViewState; stats(): Record<string, number> }
  }
}

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!
const status = document.querySelector<HTMLElement>("#status")!

const renderer = new WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight, false)

const scene = new Scene()
const sky = new HemisphereLight()
const sun = new DirectionalLight()
sun.position.set(-800, 1200, 600)
scene.add(sky, sun)

const LIGHTING: Record<Light, { background: number; sky: number; ground: number; skyI: number; sun: number; sunI: number }> = {
  day: { background: 0x0b1020, sky: 0xbfd4ff, ground: 0x1a1f2e, skyI: 1.2, sun: 0xffffff, sunI: 1.6 },
  night: { background: 0x03050b, sky: 0x5a6a9a, ground: 0x0a0d18, skyI: 0.8, sun: 0x9fb4ff, sunI: 0.5 },
}

function applyLighting(light: Light): void {
  const l = LIGHTING[light]
  scene.background = new Color(l.background)
  scene.fog = new Fog(l.background, 2500, 6000)
  sky.color.set(l.sky)
  sky.groundColor.set(l.ground)
  sky.intensity = l.skyI
  sun.color.set(l.sun)
  sun.intensity = l.sunI
}

const camera = new PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 20000)
const controls = new MapControls(camera, canvas)
controls.enableDamping = true
controls.maxPolarAngle = Math.PI / 2.05

const layers = createLayers()
for (const layer of layers) scene.add(layer.group)

let view = parseViewState(location.hash)

function applyView(next: ViewState): void {
  const selectionChanged = next.sel !== view.sel
  view = next
  camera.position.set(...next.cam)
  controls.target.set(...next.tgt)
  controls.update()
  for (const layer of layers) layer.group.visible = next.layers == null || next.layers.includes(layer.id)
  applyLighting(next.light)
  if (selectionChanged) for (const layer of layers) layer.select?.(next.sel)
}

function writeUrl(): void {
  const hash = serializeViewState(view)
  if (hash !== location.hash) history.replaceState(null, "", hash)
}

// The URL always describes the current view, so a review note reproduces it.
function captureCamera(): void {
  view = { ...view, cam: camera.position.toArray(), tgt: controls.target.toArray() }
  writeUrl()
}

function setView(next: ViewState): void {
  applyView(next)
  writeUrl()
}

applyView(view)
for (const layer of layers) layer.select?.(view.sel)
// Damping keeps the camera moving for seconds after the pointer is released ("end"),
// so the URL follows it while it glides, not only once it has settled.
const follow = followCamera(captureCamera)
controls.addEventListener("change", follow.moved)
controls.addEventListener("end", follow.ended)
// A hash that keeps the view's camera (the ask panel changing only the selection)
// keeps the live camera too, rather than snapping back to the last saved position,
// which lags a moving camera. The hash rounds positions to 0.1 m.
const near = (a: Vec3, b: Vec3) => a.every((v, i) => Math.abs(v - b[i]!) < 0.06)
window.addEventListener("hashchange", () => {
  const next = parseViewState(location.hash)
  // Layers load their data once, for one mode and time: a link to another (a review
  // plan's step, an edited URL) loads the page again.
  if (next.mode !== view.mode || next.t !== view.t) return location.reload()
  const keepCamera = near(next.cam, view.cam) && near(next.tgt, view.tgt)
  applyView(keepCamera ? { ...next, cam: camera.position.toArray(), tgt: controls.target.toArray() } : next)
})
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight, false)
})

// A click (not a drag) selects whatever the first layer that answers says it hit.
const raycaster = new Raycaster()
let downAt: { x: number; y: number } | null = null
canvas.addEventListener("pointerdown", (e) => {
  downAt = { x: e.clientX, y: e.clientY }
})
canvas.addEventListener("pointerup", (e) => {
  if (downAt == null || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return
  const rect = canvas.getBoundingClientRect()
  const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
  raycaster.setFromCamera(ndc, camera)
  let hit: string | null = null
  for (const layer of layers) {
    if (!layer.group.visible || layer.pick == null) continue
    hit = layer.pick(raycaster)
    if (hit != null) break
  }
  setView({ ...view, cam: camera.position.toArray(), tgt: controls.target.toArray(), sel: hit })
})

mountControls(document.querySelector<HTMLElement>("#controls")!, {
  camera,
  controls,
  layers,
  getView: () => view,
  setView,
})
const askSettled = mountAskPanel(document.querySelector<HTMLElement>("#ask")!, () => view)

let last = performance.now()
renderer.setAnimationLoop((now) => {
  const dt = now - last
  last = now
  for (const layer of layers) layer.update?.(now, dt)
  controls.update()
  renderer.render(scene, camera)
})

// A layer that fails to load is reported, not fatal: the rest of the city still draws.
const results = await Promise.allSettled(layers.map((layer) => layer.init({ mode: view.mode, time: view.t })))
const errors = results.flatMap((r, i) => (r.status === "rejected" ? [`${layers[i]!.id}: ${String(r.reason)}`] : []))
// Live layers refresh their data, so the status line is read again every few seconds.
// The streets and the venue pin speak for themselves on screen, so the line keeps to
// what loads and changes, short enough to read from the back of a room.
const QUIET_LAYERS = new Set(["ground", "venue"])
function renderStatus(): void {
  const summaries = layers
    .filter((l) => !QUIET_LAYERS.has(l.id))
    .map((l) => l.summary?.())
    .filter((s): s is string => s != null && s !== "")
  status.textContent = [...summaries, ...errors.map((e) => `failed: ${e}`)].join(" · ") || "ready"
}
renderStatus()
setInterval(renderStatus, 5_000)
for (const layer of layers) layer.select?.(view.sel)
// A question in the URL is part of the view: report ready once its answer shows.
await askSettled

// Two frames after the last layer loads, everything is on screen.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    window.__nycLive = {
      ready: true,
      layers: layers.map((l) => l.id),
      errors,
      view,
      stats: () => ({ ...renderer.info.render, ...renderer.info.memory }),
    }
  }),
)
