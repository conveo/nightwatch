import {
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  type Material,
  type Raycaster,
} from "three"
import type { GarageState } from "../../server/city-state.ts"
import { inArea } from "../constants.ts"
import { toLocal } from "../geo.ts"
import type { DataMode, Light } from "../view-state.ts"
import type { Layer, LayerContext } from "./types.ts"

// Parking garages with their occupancy (Stad Gent open data), one column per garage
// inside AREA. The column's height is the garage's capacity, its solid lower part the
// occupied places and the glassy part above it the free ones; its colour is the share
// still free, from red (full) to green (empty). A garage is selected as
// `garage:<slug>` (plan/PLAN.md, "Contracts").
//
// Data by mode: fixture reads public/fixtures/parking.json, recorded the snapshot
// nearest to `t` in public/fixtures/parking/snapshots.json, and live the dev server's
// /api/parking (server/routes/parking.ts) every minute; the browser never fetches
// the city's feed itself.

// 600 places stand 90 m tall, as tall as the Belfry: clearly above a typical block of
// 10 to 20 m, so the columns read once the buildings stand around them.
export const METRES_PER_PLACE = 0.15
export const COLUMN_RADIUS_M = 15
export const STALE_AFTER_MS = 15 * 60_000
export const REFRESH_MS = 60_000

export const DATA_URL: Record<DataMode, string> = {
  fixture: "/fixtures/parking.json",
  recorded: "/fixtures/parking/snapshots.json",
  live: "/api/parking",
}

export type ParkingSnapshot = { time: string; garages: GarageState[] }
export type SnapshotFile = { snapshots: Record<string, GarageState[]> }

export type ColumnSpec = { height: number; filled: number; free: number; color: number }

// The share of places still free, 0..1. A garage without capacity counts as full.
export function freeShare(g: Pick<GarageState, "capacity" | "available">): number {
  if (!(g.capacity > 0)) return 0
  return Math.min(1, Math.max(0, g.available / g.capacity))
}

// Red when full, through orange and yellow to green when empty. The square root
// spends most of the range near full, where the share free matters to a driver: a
// garage with a quarter of its places free is already yellow-green.
export function freeColor(free: number): number {
  return new Color().setHSL(Math.sqrt(Math.min(1, Math.max(0, free))) * 0.36, 0.9, 0.52, SRGBColorSpace).getHex()
}

export function columnSpec(g: Pick<GarageState, "capacity" | "available">): ColumnSpec {
  const free = freeShare(g)
  const height = Math.max(0, g.capacity) * METRES_PER_PLACE
  return { height, filled: height * (1 - free), free, color: freeColor(free) }
}

// The recorded snapshot nearest to `time`, or the latest when `time` is null.
export function nearestSnapshot(file: SnapshotFile, time: string | null): ParkingSnapshot | null {
  const target = time == null ? Number.POSITIVE_INFINITY : Date.parse(time)
  let best: { time: string; at: number } | null = null
  for (const t of Object.keys(file.snapshots ?? {})) {
    const at = Date.parse(t)
    if (Number.isNaN(at)) continue
    if (best == null) {
      best = { time: t, at }
      continue
    }
    const d = Math.abs(at - target)
    const bestD = Math.abs(best.at - target)
    if (d < bestD || (d === bestD && at > best.at)) best = { time: t, at }
  }
  return best == null ? null : { time: best.time, garages: file.snapshots[best.time]! }
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 120) return `${minutes} minutes`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} hours` : `${Math.floor(hours / 24)} days`
}

// The HUD line when the data is more than 15 minutes old, else null. Live data is
// measured against now; a recorded snapshot against the time asked for in the URL
// (the age either way, as a snapshot after `t` does not show `t` either). Fixture
// data is a sample, never "stale".
export function staleNotice(garages: GarageState[], mode: DataMode, referenceMs: number): string | null {
  if (mode === "fixture" || garages.length === 0) return null
  const ages = garages.map((g) => {
    const age = referenceMs - Date.parse(g.updated)
    return { name: g.name, age: Number.isNaN(age) ? Number.POSITIVE_INFINITY : mode === "recorded" ? Math.abs(age) : age }
  })
  const stale = ages.filter((a) => a.age > STALE_AFTER_MS)
  if (stale.length === 0) return null
  if (stale.length < ages.length) {
    const names = stale.map((s) => s.name)
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
    return `parking data for ${list} is more than 15 minutes old`
  }
  const youngest = Math.min(...stale.map((s) => s.age))
  if (!Number.isFinite(youngest)) return "parking data has no valid time"
  return mode === "recorded"
    ? `parking snapshot is ${formatAge(youngest)} from the requested time`
    : `parking data is ${formatAge(youngest)} old`
}

export function garageIdOf(sel: string | null): string | null {
  return sel != null && sel.startsWith("garage:") ? sel.slice("garage:".length) : null
}

type Column = {
  garage: GarageState
  group: Group
  hit: Mesh[]
  rim: Mesh
  base: Mesh
  materials: { fill: MeshStandardMaterial; shell: MeshStandardMaterial; rim: MeshBasicMaterial }
  label: Sprite | null
}

const EMISSIVE: Record<Light, { fill: number; shell: number }> = {
  day: { fill: 0.45, shell: 0.35 },
  night: { fill: 0.9, shell: 0.6 },
}

// A label above the selected column: name and free places, readable on a projector.
function labelSprite(g: GarageState): Sprite {
  const text = `${g.name} · ${g.available} of ${g.capacity} free`
  const canvas = document.createElement("canvas")
  const ctx = canvas.getContext("2d")!
  const font = "600 44px system-ui, sans-serif"
  ctx.font = font
  const width = Math.ceil(ctx.measureText(text).width) + 48
  canvas.width = width
  canvas.height = 72
  ctx.font = font
  ctx.fillStyle = "rgba(8, 12, 24, 0.85)"
  ctx.fillRect(0, 0, width, 72)
  ctx.fillStyle = "#ffffff"
  ctx.textBaseline = "middle"
  ctx.fillText(text, 24, 38)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  const sprite = new Sprite(new SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false }))
  // With sizeAttenuation off the size no longer depends on distance: one unit of
  // scale is about 1.2 view heights at a 45° field of view, so 0.045 makes the label
  // ~49 px tall in a 900 px view, its text ~30 px.
  const h = 0.045
  sprite.scale.set((h * width) / 72, h, 1)
  sprite.center.set(0.5, 0)
  sprite.renderOrder = 10
  return sprite
}

export function createParkingLayer(options: { fetch?: typeof fetch; now?: () => number } = {}): Layer & {
  garages(): GarageState[]
} {
  const fetchJson = async (url: string): Promise<unknown> => {
    const res = await (options.fetch ?? fetch)(url, { headers: { Accept: "application/json" } })
    if (!res.ok) throw new Error(`${url} answered ${res.status}`)
    return res.json()
  }
  const now = options.now ?? (() => Date.now())
  const group = new Group()
  group.name = "parking"
  // Shared shapes, scaled per column: a unit cylinder for the solid and glass parts.
  const unit = new CylinderGeometry(1, 1, 1, 40)
  // The selected garage also gets a white ring on the ground.
  const baseRing = new RingGeometry(COLUMN_RADIUS_M + 3, COLUMN_RADIUS_M + 7, 48)
  const baseMat = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide })
  let columns: Column[] = []
  let shown: GarageState[] = []
  let mode: DataMode = "fixture"
  let time: string | null = null
  let snapshotTime: string | null = null
  let light: Light = "day"
  let selected: string | null = null
  // Live mode only: why the data could not be read, while none has been.
  let unavailable: string | null = null

  function disposeColumn(c: Column): void {
    c.rim.geometry.dispose()
    for (const m of Object.values(c.materials) as Material[]) m.dispose()
    if (c.label != null) {
      c.label.material.map?.dispose()
      c.label.material.dispose()
    }
  }

  function applyLight(): void {
    const e = EMISSIVE[light]
    for (const c of columns) {
      c.materials.fill.emissiveIntensity = e.fill
      c.materials.shell.emissiveIntensity = e.shell
    }
  }

  function applySelection(): void {
    for (const c of columns) {
      const on = c.garage.slug === selected
      c.base.visible = on
      c.materials.rim.color.set(on ? 0xffffff : columnSpec(c.garage).color)
      if (on && c.label == null && typeof document !== "undefined") {
        c.label = labelSprite(c.garage)
        c.label.position.y = columnSpec(c.garage).height + 8
        c.group.add(c.label)
      }
      if (c.label != null) c.label.visible = on
    }
  }

  function build(garages: GarageState[]): void {
    for (const c of columns) {
      group.remove(c.group)
      disposeColumn(c)
    }
    shown = garages.filter((g) => inArea(g))
    columns = shown.map((garage) => {
      const spec = columnSpec(garage)
      const color = new Color(spec.color)
      const { x, z } = toLocal(garage)
      const g = new Group()
      g.name = `garage:${garage.slug}`
      g.position.set(x, 0, z)
      const fillMat = new MeshStandardMaterial({ color, emissive: color, roughness: 0.45, metalness: 0.1 })
      const shellMat = new MeshStandardMaterial({
        color,
        emissive: color,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        roughness: 0.2,
      })
      const rimMat = new MeshBasicMaterial({ color })
      const fill = new Mesh(unit, fillMat)
      fill.scale.set(COLUMN_RADIUS_M, Math.max(spec.filled, 0.5), COLUMN_RADIUS_M)
      fill.position.y = Math.max(spec.filled, 0.5) / 2
      const shell = new Mesh(unit, shellMat)
      shell.scale.set(COLUMN_RADIUS_M + 0.6, spec.height, COLUMN_RADIUS_M + 0.6)
      shell.position.y = spec.height / 2
      // A bright rim marks the capacity at the top, from every angle.
      const rim = new Mesh(new TorusGeometry(COLUMN_RADIUS_M + 0.6, 1.1, 8, 48), rimMat)
      rim.rotation.x = Math.PI / 2
      rim.position.y = spec.height
      const base = new Mesh(baseRing, baseMat)
      base.rotation.x = -Math.PI / 2
      base.position.y = 0.8
      base.visible = false
      for (const m of [fill, shell]) m.userData.slug = garage.slug
      g.add(fill, shell, rim, base)
      group.add(g)
      return {
        garage,
        group: g,
        hit: [fill, shell],
        rim,
        base,
        materials: { fill: fillMat, shell: shellMat, rim: rimMat },
        label: null,
      }
    })
    applyLight()
    applySelection()
  }

  async function load(): Promise<void> {
    if (mode === "recorded") {
      const snapshot = nearestSnapshot((await fetchJson(DATA_URL.recorded)) as SnapshotFile, time)
      if (snapshot == null) throw new Error("no recorded parking snapshot")
      snapshotTime = snapshot.time
      build(snapshot.garages)
      return
    }
    const snapshot = (await fetchJson(DATA_URL[mode])) as ParkingSnapshot
    snapshotTime = snapshot.time
    build(snapshot.garages)
  }

  return {
    id: "parking",
    group,
    garages: () => shown,
    async init(ctx: LayerContext) {
      mode = ctx.mode
      time = ctx.time
      // Fixture and recorded data are files: if one fails, the layer fails.
      if (mode !== "live") return load()
      // Live data is retried every minute, also when the first read fails, so the
      // columns appear once /api/parking answers. A failed refresh keeps the last
      // data, and the notice reports its age.
      let busy = false
      const refresh = async (): Promise<void> => {
        if (busy) return
        busy = true
        try {
          await load()
          unavailable = null
        } catch (error) {
          if (snapshotTime == null) unavailable = (error as Error).message
        } finally {
          busy = false
        }
      }
      await refresh()
      setInterval(() => void refresh(), REFRESH_MS)
    },
    notice() {
      if (unavailable != null) return `parking data unavailable, retrying every minute (${unavailable})`
      const reference = mode === "recorded" ? Date.parse(time ?? snapshotTime ?? "") : now()
      return staleNotice(shown, mode, Number.isNaN(reference) ? now() : reference)
    },
    setLight(next: Light) {
      light = next
      applyLight()
    },
    pick(ray: Raycaster) {
      const hits = ray.intersectObjects(
        columns.flatMap((c) => c.hit),
        false,
      )
      const slug = hits[0]?.object.userData.slug as string | undefined
      return slug == null ? null : `garage:${slug}`
    },
    select(id: string | null) {
      selected = garageIdOf(id)
      applySelection()
    },
  }
}
