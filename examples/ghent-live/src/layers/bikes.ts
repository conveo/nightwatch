import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  type Raycaster,
} from "three"
import type { BikeStationState } from "../../server/city-state.ts"
import type { BikeOperator, BikesAnswer, FeedStatus } from "../../server/routes/bikes.ts"
import { inArea } from "../constants.ts"
import { toLocal } from "../geo.ts"
import type { DataMode } from "../view-state.ts"
import type { Layer } from "./types.ts"

// Shared-bike stations (Donkey Republic, Bolt, Blue-bike): one thin bar per station
// inside AREA, its height by the bikes available, one colour per operator. Fixture
// mode reads public/fixtures/bikes.json; live mode reads the dev server's own
// /api/bikes route (server/routes/bikes.ts) and refreshes every minute. There are no
// recorded bike snapshots, so recorded mode shows the fixture and says so. Owned by
// ticket T6 in plan/PLAN.md.

export const OPERATOR_COLORS: Record<BikeOperator, number> = {
  donkey: 0xff7a1a, // Donkey Republic's orange
  bolt: 0x2fe08f, // Bolt's green
  "blue-bike": 0x3d8bff, // Blue-bike's blue
}
export const OPERATOR_NAMES: Record<BikeOperator, string> = {
  donkey: "Donkey Republic",
  bolt: "Bolt",
  "blue-bike": "Blue-bike",
}
const OPERATOR_LIST = Object.keys(OPERATOR_NAMES) as BikeOperator[]
const SELECTED_COLOR = 0xffffff

// Bars stay thin and below the shortest parking garage column inside AREA (T5: 15 m
// radius, 0.15 m per place, 22 m for the smallest). A station with no bikes still
// shows, as a short post.
export const BAR_WIDTH_M = 1
export const EMPTY_BAR_M = 6
export const METRES_PER_BIKE = 3.5
export const MAX_BAR_M = 20
// Thin bars are hard to hit with a click, so picking uses wider, invisible boxes.
const PICK_WIDTH_M = 9
const PICK_MIN_HEIGHT_M = 12

export const SOURCES: Record<DataMode, string> = {
  fixture: "/fixtures/bikes.json",
  recorded: "/fixtures/bikes.json",
  live: "/api/bikes",
}
const REFRESH_MS = 60_000
// Until live data has arrived once, a failed request is retried sooner.
const RETRY_MS = 10_000
// Live data older than this (refreshes failing) is reported in the notice.
const STALE_MS = 5 * 60_000

export function barHeight(available: number): number {
  return Math.min(MAX_BAR_M, EMPTY_BAR_M + Math.max(0, available) * METRES_PER_BIKE)
}

// `bikes:<operator>:<station id>` (plan/PLAN.md, "Contracts").
export function stationKey(station: Pick<BikeStationState, "operator" | "id">): string {
  return `bikes:${station.operator}:${station.id}`
}

function isStation(value: unknown): value is BikeStationState {
  const s = value as Partial<BikeStationState> | null
  return (
    s != null &&
    typeof s === "object" &&
    OPERATOR_LIST.includes(s.operator as BikeOperator) &&
    typeof s.id === "string" &&
    s.id !== "" &&
    typeof s.name === "string" &&
    Number.isFinite(s.lat) &&
    Number.isFinite(s.lon) &&
    Number.isFinite(s.available)
  )
}

const FEED_STATUSES: readonly FeedStatus[] = ["ok", "partial", "missing"]

// An answer from /api/bikes or the fixture, checked: malformed stations are dropped,
// and an operator whose status is unknown counts as missing.
export function parseBikesAnswer(body: unknown): BikesAnswer {
  const raw = (body ?? {}) as { time?: unknown; stations?: unknown; feeds?: Record<string, unknown> }
  if (!Array.isArray(raw.stations)) throw new Error("bike data has no station list")
  const feeds = {} as Record<BikeOperator, FeedStatus>
  for (const op of OPERATOR_LIST) {
    const status = raw.feeds?.[op]
    feeds[op] = FEED_STATUSES.includes(status as FeedStatus) ? (status as FeedStatus) : "missing"
  }
  return {
    time: typeof raw.time === "string" ? raw.time : "",
    stations: raw.stations.filter(isStation),
    feeds,
  }
}

// The HUD line: live data that has not arrived yet or not refreshed for a while, an
// operator whose data is missing or incomplete, and recorded mode, which has no bike
// snapshots.
export function bikesNotice(answer: BikesAnswer | null, mode: DataMode, nowMs: number): string | null {
  if (answer == null) return mode === "live" ? "Shared bikes: no data yet, retrying" : null
  const parts: string[] = []
  if (mode === "recorded") parts.push("no recorded data, showing the sample")
  for (const op of OPERATOR_LIST) {
    if (answer.feeds[op] === "missing") parts.push(`no ${OPERATOR_NAMES[op]} data`)
    if (answer.feeds[op] === "partial") parts.push(`${OPERATOR_NAMES[op]} data incomplete`)
  }
  const age = nowMs - Date.parse(answer.time)
  if (mode === "live" && age > STALE_MS) parts.push(`data is ${Math.round(age / 60_000)} min old`)
  return parts.length === 0 ? null : `Shared bikes: ${parts.join(", ")}`
}

async function load(url: string): Promise<BikesAnswer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return parseBikesAnswer(await res.json())
}

export function createBikesLayer(): Layer {
  const group = new Group()
  group.name = "bikes"
  // A unit box standing on the ground (y from 0 to 1), scaled per station.
  const unit = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
  // Unlit, so an operator's colour reads the same on every side, by day and by night.
  const material = new MeshBasicMaterial()
  const pickMaterial = new MeshBasicMaterial()

  let mode: DataMode = "fixture"
  let selected: string | null = null
  let answer: BikesAnswer | null = null
  let drawn: BikeStationState[] = []
  let bars: InstancedMesh | null = null
  let pickBoxes: InstancedMesh | null = null

  // Positions, sizes and colours of every bar; the selected one is white and wider.
  function place(): void {
    const shown = bars
    const picks = pickBoxes
    if (shown == null || picks == null) return
    const o = new Object3D()
    const color = new Color()
    drawn.forEach((station, i) => {
      const { x, z } = toLocal(station)
      const height = barHeight(station.available)
      const isSelected = stationKey(station) === selected
      const width = isSelected ? BAR_WIDTH_M * 2 : BAR_WIDTH_M
      o.position.set(x, 0, z)
      o.scale.set(width, height, width)
      o.updateMatrix()
      shown.setMatrixAt(i, o.matrix)
      shown.setColorAt(i, color.set(isSelected ? SELECTED_COLOR : OPERATOR_COLORS[station.operator]))
      o.scale.set(PICK_WIDTH_M, Math.max(height, PICK_MIN_HEIGHT_M), PICK_WIDTH_M)
      o.updateMatrix()
      picks.setMatrixAt(i, o.matrix)
    })
    shown.instanceMatrix.needsUpdate = true
    if (shown.instanceColor != null) shown.instanceColor.needsUpdate = true
    picks.instanceMatrix.needsUpdate = true
    shown.computeBoundingSphere()
    picks.computeBoundingSphere()
  }

  function draw(next: BikesAnswer): void {
    answer = next
    drawn = next.stations.filter((s) => inArea(s))
    for (const mesh of [bars, pickBoxes]) {
      if (mesh == null) continue
      group.remove(mesh)
      mesh.dispose()
    }
    const capacity = Math.max(1, drawn.length)
    bars = new InstancedMesh(unit, material, capacity)
    bars.name = "bike-bars"
    pickBoxes = new InstancedMesh(unit, pickMaterial, capacity)
    pickBoxes.name = "bike-pick"
    pickBoxes.visible = false
    bars.count = pickBoxes.count = drawn.length
    place()
    group.add(bars, pickBoxes)
  }

  return {
    id: "bikes",
    group,
    async init(ctx) {
      mode = ctx.mode
      if (mode !== "live") return draw(await load(SOURCES[mode]))
      // Live data refreshes every minute, and a failed request, the first one included,
      // is retried: until data arrives the notice says so; after that a failed refresh
      // keeps the last data and the notice reports its age.
      const refresh = async (): Promise<void> => {
        try {
          draw(await load(SOURCES.live))
        } catch {
          // Reported by notice(); the next attempt is already scheduled below.
        }
        setTimeout(refresh, answer == null ? RETRY_MS : REFRESH_MS)
      }
      await refresh()
    },
    notice() {
      return bikesNotice(answer, mode, Date.now())
    },
    pick(ray: Raycaster) {
      if (pickBoxes == null) return null
      // The pick boxes are hidden; intersectObject tests them all the same.
      const hit = ray.intersectObject(pickBoxes, false)[0]
      const station = hit?.instanceId == null ? undefined : drawn[hit.instanceId]
      return station == null ? null : stationKey(station)
    },
    select(id) {
      selected = id != null && id.startsWith("bikes:") ? id : null
      place()
    },
  }
}
