import {
  BoxGeometry,
  Color,
  EdgesGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshStandardMaterial,
  type Raycaster,
} from "three"
import type { CitibikeDock, CitibikeSnapshot } from "../../server/routes/citibike.ts"
import { toLocal } from "../geo.ts"
import type { Layer, LayerContext } from "./types.ts"

// Citi Bike docks as bars whose height is the number of bikes available: classic
// bikes in Citi Bike blue, e-bikes stacked on top in green. A dock with no bike to
// rent keeps a short grey stub, so it still shows where it is. Fixture and recorded
// mode draw public/fixtures/citibike.json; live mode reads /api/citibike (the
// server reads the feed) and refreshes every 30 s. `pick` answers "dock:<station id>",
// and the selected dock gets a white outline.

export const METRES_PER_BIKE = 1
export const BAR_WIDTH_M = 8
export const STUB_HEIGHT_M = 1.5
export const LIVE_REFRESH_MS = 30_000

export const COLOURS = { classic: 0x1f7bff, ebike: 0x5be35b, empty: 0x6b7280 }

export type BarSegment = { bottom: number; height: number; colour: number }

// The two stacked segments of a dock's bar, classic below and e-bikes above. A
// segment with no bikes has height 0 (it is drawn, but invisible).
export function barSegments(dock: CitibikeDock): [classic: BarSegment, ebike: BarSegment] {
  if (!dock.renting || dock.bikes === 0) {
    return [
      { bottom: 0, height: STUB_HEIGHT_M, colour: COLOURS.empty },
      { bottom: STUB_HEIGHT_M, height: 0, colour: COLOURS.ebike },
    ]
  }
  const classic = (dock.bikes - dock.ebikes) * METRES_PER_BIKE
  return [
    { bottom: 0, height: classic, colour: COLOURS.classic },
    { bottom: classic, height: dock.ebikes * METRES_PER_BIKE, colour: COLOURS.ebike },
  ]
}

// For the HUD. Like the bars, it counts only bikes at docks that are renting. It
// ends with the feed's time in New York, because main.ts reads it once after
// startup: after a live refresh, the line still says which moment it describes.
export function summarize(snapshot: CitibikeSnapshot): string {
  const renting = snapshot.docks.filter((d) => d.renting)
  const bikes = renting.reduce((n, d) => n + d.bikes, 0)
  const ebikes = renting.reduce((n, d) => n + d.ebikes, 0)
  const fmt = (n: number) => n.toLocaleString("en-US")
  const line = `${fmt(snapshot.docks.length)} Citi Bike docks · ${fmt(bikes)} bikes (${fmt(ebikes)} e-bikes)`
  const updated = new Date(snapshot.updated)
  if (Number.isNaN(updated.getTime())) return line
  const at = updated.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  return `${line} at ${at}`
}

async function load(mode: LayerContext["mode"]): Promise<CitibikeSnapshot> {
  const url = mode === "live" ? "/api/citibike" : `${import.meta.env.BASE_URL}fixtures/citibike.json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as CitibikeSnapshot
}

export function createCitibikeLayer(): Layer {
  const group = new Group()
  group.name = "citibike"
  // A unit box standing on y = 0, scaled per segment.
  const box = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
  const material = new MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 })
  let mesh: InstancedMesh | null = null
  let snapshot: CitibikeSnapshot = { updated: "", docks: [] }
  let selected: string | null = null
  let mode: LayerContext["mode"] = "fixture"
  let lastLoad = 0
  let loading = false

  // Drawn around the selected dock's bar, a little larger than the bar.
  const outline = new LineSegments(new EdgesGeometry(box), new LineBasicMaterial({ color: 0xffffff }))
  outline.visible = false
  group.add(outline)

  function placeOutline(): void {
    const dock = snapshot.docks.find((d) => d.id === selected)
    outline.visible = dock != null
    if (dock == null) return
    const [classic, ebike] = barSegments(dock)
    const { x, z } = toLocal(dock)
    outline.scale.set(BAR_WIDTH_M + 3, classic.height + ebike.height + 3, BAR_WIDTH_M + 3)
    outline.position.set(x, 0, z)
  }

  function draw(next: CitibikeSnapshot): void {
    snapshot = next
    const { docks } = next
    if (mesh != null) {
      group.remove(mesh)
      mesh.dispose()
    }
    mesh = new InstancedMesh(box, material, docks.length * 2)
    const matrix = new Matrix4()
    const colour = new Color()
    docks.forEach((dock, i) => {
      const { x, z } = toLocal(dock)
      barSegments(dock).forEach((segment, j) => {
        matrix.makeScale(BAR_WIDTH_M, segment.height, BAR_WIDTH_M).setPosition(x, segment.bottom, z)
        mesh!.setMatrixAt(i * 2 + j, matrix)
        mesh!.setColorAt(i * 2 + j, colour.set(segment.colour))
      })
    })
    mesh.computeBoundingSphere()
    group.add(mesh)
    placeOutline()
  }

  async function refresh(): Promise<void> {
    loading = true
    lastLoad = performance.now()
    try {
      draw(await load(mode))
    } finally {
      loading = false
    }
  }

  return {
    id: "citibike",
    group,
    async init(ctx) {
      mode = ctx.mode
      await refresh()
    },
    update(nowMs) {
      if (mode !== "live" || loading || nowMs - lastLoad < LIVE_REFRESH_MS) return
      // A failed refresh keeps the bars from the last good answer.
      refresh().catch((error: unknown) => console.warn("citibike refresh failed:", error))
    },
    summary: () => (snapshot.docks.length === 0 ? null : summarize(snapshot)),
    pick(ray: Raycaster) {
      if (mesh == null) return null
      const hit = ray.intersectObject(mesh, false)[0]
      const dock = hit?.instanceId == null ? undefined : snapshot.docks[Math.floor(hit.instanceId / 2)]
      return dock == null ? null : `dock:${dock.id}`
    },
    select(id) {
      selected = id?.startsWith("dock:") ? id.slice("dock:".length) : null
      placeOutline()
    },
  }
}
