import { Vector3, type PerspectiveCamera } from "three"
import { toLocal } from "../geo.ts"
import { PLACES } from "../places.ts"

// Name labels for the landmarks in src/places.ts, drawn as HTML over the scene so the
// text stays sharp and large (26px) at any distance. The layout is a pure function so
// the tests check it without a browser; mountLabels() does the DOM.

export type Rect = { x: number; y: number; w: number; h: number }
export type Point = { x: number; y: number }

// Where a label's dot sits, in metres above the ground: just above the tower tops
// (the buildings layer draws the Belfry 90 m, Sint-Baafs 81 m and Sint-Niklaas 60 m
// tall), so a view from the street reads the towers' names against the sky.
export const LABEL_HEIGHT_M: Readonly<Record<string, number>> = {
  belfort: 95,
  "sint-baafs": 86,
  "sint-niklaas": 65,
  stadhuis: 25,
  gravensteen: 30,
  graslei: 15,
  "sint-michielsbrug": 8,
  vrijdagmarkt: 5,
}

// The label text: the short Dutch name a Ghent audience uses (the presets' names);
// the full name shows on hover. Places without one show their Dutch name.
export const LABEL_TEXT: Readonly<Record<string, string>> = {
  belfort: "Belfort",
  "sint-baafs": "Sint-Baafs",
  "sint-niklaas": "Sint-Niklaas",
  graslei: "Graslei",
}

// Which label wins when two would overlap: the three towers first.
export const LABEL_ORDER: readonly string[] = [
  "belfort",
  "sint-niklaas",
  "sint-baafs",
  "gravensteen",
  "graslei",
  "stadhuis",
  "vrijdagmarkt",
  "sint-michielsbrug",
]

// The radius around a landmark's foot, in metres, that no label covers: the label
// names the landmark, it should not hide it. The Belfry's is wider, for the red
// ring that marks the scene origin there (radius 34 m).
export const FOOT_RADIUS_M: Readonly<Record<string, number>> = { belfort: 40 }
export const DEFAULT_FOOT_RADIUS_M = 30

// A label closer than this to the camera is where you are standing, not something
// to point at.
export const MIN_LABEL_DISTANCE_M = 40

// `anchor` is the dot (the projected label height), `foot` the box around the
// landmark's projected foot, both in pixels, or null when not on screen.
export type LabelInput = { id: string; anchor: Point | null; foot: Rect | null; w: number; h: number }
// Where a label goes (its top-left corner), and whether it hangs on a stem from its dot.
export type Placement = Point & { pin: boolean }

// A label hangs this far above (or below) its dot, on a stem; beside the dot it keeps
// a shorter gap.
export const STEM_PX = 44
const SIDE_PX = 16
const DOT_PX = 16
// The least space kept between a label and anything else, and between a label and
// the panels or the edge of the screen, in pixels.
const PAD = 8
const PANEL_PAD = 16

function overlaps(a: Rect, b: Rect, pad = PAD): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad
}

function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

// Places each label next to what it names: above if there is room, else below, to
// the right or left, or above but shifted to one side. Usually that is next to its
// dot, on a stem. Seen from overhead a tower's top falls on its own foot, so there
// the label sits beside the foot instead, with no dot or stem.
//
// A label never leaves the viewport and never covers another label, a dot, an
// obstacle (the title, the panels) or a landmark's foot. One that fits nowhere is
// hidden (null), and so is one whose dot is off screen or under an obstacle. Labels
// earlier in the list win.
export function layoutLabels(
  labels: readonly LabelInput[],
  viewport: { w: number; h: number },
  obstacles: readonly Rect[] = [],
): Map<string, Placement | null> {
  const feet = labels.flatMap((l) => (l.foot == null ? [] : [l.foot]))
  const pinned = (l: LabelInput): boolean => l.anchor != null && !feet.some((f) => contains(f, l.anchor!))
  // Every dot stays uncovered, so each label still points at its own landmark.
  const dots: Rect[] = labels.flatMap((l) =>
    l.anchor == null || !pinned(l) ? [] : [{ x: l.anchor.x - DOT_PX / 2, y: l.anchor.y - DOT_PX / 2, w: DOT_PX, h: DOT_PX }],
  )
  const placed: Rect[] = []
  const out = new Map<string, Placement | null>()
  for (const label of labels) {
    const a = label.anchor
    if (a == null || a.x < 0 || a.y < 0 || a.x > viewport.w || a.y > viewport.h || obstacles.some((o) => contains(o, a))) {
      out.set(label.id, null)
      continue
    }
    const pin = pinned(label)
    // What the label stands next to: the dot, or the landmark's foot.
    const box: Rect = pin || label.foot == null ? { x: a.x, y: a.y, w: 0, h: 0 } : label.foot
    const gapV = pin ? STEM_PX : SIDE_PX
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    const { w, h } = label
    const candidates: Point[] = [
      { x: cx - w / 2, y: box.y - gapV - h },
      { x: cx - w / 2, y: box.y + box.h + gapV },
      { x: box.x + box.w + SIDE_PX, y: cy - h / 2 },
      { x: box.x - SIDE_PX - w, y: cy - h / 2 },
      { x: cx - w + SIDE_PX, y: box.y - gapV - h },
      { x: cx - SIDE_PX, y: box.y - gapV - h },
    ]
    const fit = candidates.find((c) => {
      const r = { x: c.x, y: c.y, w, h }
      const inside = r.x >= PANEL_PAD && r.y >= PANEL_PAD && r.x + w <= viewport.w - PANEL_PAD && r.y + h <= viewport.h - PANEL_PAD
      const clear = (o: Rect): boolean => !overlaps(r, o)
      const clearOfPanel = (o: Rect): boolean => !overlaps(r, o, PANEL_PAD)
      return inside && obstacles.every(clearOfPanel) && placed.every(clear) && dots.every(clear) && feet.every(clear)
    })
    if (fit != null) placed.push({ ...fit, w, h })
    out.set(label.id, fit == null ? null : { ...fit, pin })
  }
  return out
}

// Where the stem from a dot meets its label: the label's nearest point.
export function stemEnd(anchor: Point, label: Rect): Point {
  return {
    x: Math.max(label.x, Math.min(anchor.x, label.x + label.w)),
    y: Math.max(label.y, Math.min(anchor.y, label.y + label.h)),
  }
}

export type LabelsContext = {
  camera: PerspectiveCamera
  // The rectangles labels must keep clear of (the title, the panels), in pixels.
  obstacles: () => Rect[]
  selected: () => string | null
  onSelect: (slug: string) => void
}

const SVG = "http://www.w3.org/2000/svg"

// One label per place, positioned every frame. Clicking (or tapping) a label selects
// the place (`place:<slug>`, see plan/PLAN.md "Contracts").
export function mountLabels(root: HTMLElement, ctx: LabelsContext): void {
  const layer = document.createElement("div")
  layer.className = "ui-labels"
  const stems = document.createElementNS(SVG, "svg")
  stems.classList.add("ui-stems")
  stems.setAttribute("aria-hidden", "true")
  layer.append(stems)
  root.append(layer)

  const rank = (slug: string): number => {
    const i = LABEL_ORDER.indexOf(slug)
    return i < 0 ? LABEL_ORDER.length : i
  }
  const places = [...PLACES].sort((a, b) => rank(a.slug) - rank(b.slug))
  const items = places.map((place) => {
    const { x, z } = toLocal(place)
    const button = document.createElement("button")
    button.type = "button"
    button.className = "ui-label"
    button.textContent = LABEL_TEXT[place.slug] ?? place.nl
    button.title = `${place.nl} (${place.en})`
    button.addEventListener("click", () => ctx.onSelect(place.slug))
    const dot = document.createElement("span")
    dot.className = "ui-label-dot"
    const stem = document.createElementNS(SVG, "line")
    stem.setAttribute("visibility", "hidden")
    stems.append(stem)
    layer.append(dot, button)
    const r = FOOT_RADIUS_M[place.slug] ?? DEFAULT_FOOT_RADIUS_M
    const foot = [new Vector3(x - r, 0, z), new Vector3(x + r, 0, z), new Vector3(x, 0, z - r), new Vector3(x, 0, z + r)]
    const world = new Vector3(x, LABEL_HEIGHT_M[place.slug] ?? 10, z)
    return { slug: place.slug, world, foot, button, dot, stem, w: 0, h: 0, last: "" }
  })

  // Sizes change only with the text or the fonts, so they are measured then, not
  // every frame (reading a size after moving labels would force a layout per frame).
  const measure = (): void => {
    for (const item of items) {
      item.w = item.button.offsetWidth
      item.h = item.button.offsetHeight
    }
  }
  measure()
  void document.fonts?.ready.then(measure)
  window.addEventListener("resize", measure)

  const v = new Vector3()
  // A point on screen in pixels, or null behind the camera or past the far plane.
  const toScreen = (p: Vector3, w: number, h: number): Point | null => {
    v.copy(p).project(ctx.camera)
    return v.z > -1 && v.z < 1 ? { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h } : null
  }
  const frame = (): void => {
    const w = window.innerWidth
    const h = window.innerHeight
    if (items.some((i) => i.w === 0)) measure()
    ctx.camera.updateMatrixWorld()
    const inputs = items.map((item): LabelInput => {
      const far = item.world.distanceTo(ctx.camera.position) >= MIN_LABEL_DISTANCE_M
      const anchor = far ? toScreen(item.world, w, h) : null
      const corners = item.foot.map((p) => toScreen(p, w, h))
      let foot: Rect | null = null
      if (corners.every((c) => c != null)) {
        const xs = corners.map((c) => c!.x)
        const ys = corners.map((c) => c!.y)
        foot = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
      }
      return { id: item.slug, anchor, foot, w: item.w, h: item.h }
    })
    const layout = layoutLabels(inputs, { w, h }, ctx.obstacles())
    const selected = ctx.selected()
    items.forEach((item, i) => {
      const isSelected = selected === `place:${item.slug}`
      item.button.classList.toggle("is-selected", isSelected)
      item.dot.classList.toggle("is-selected", isSelected)
      const at = layout.get(item.slug) ?? null
      const anchor = inputs[i]!.anchor
      if (at == null || anchor == null) {
        if (item.last === "hidden") return
        item.last = "hidden"
        for (const el of [item.button, item.dot]) el.style.visibility = "hidden"
        item.stem.setAttribute("visibility", "hidden")
        return
      }
      const x = Math.round(at.x)
      const y = Math.round(at.y)
      const ax = Math.round(anchor.x)
      const ay = Math.round(anchor.y)
      const key = `${x},${y},${ax},${ay},${at.pin}`
      if (key === item.last) return
      item.last = key
      item.button.style.visibility = "visible"
      item.button.style.transform = `translate(${x}px, ${y}px)`
      item.dot.style.visibility = at.pin ? "visible" : "hidden"
      item.stem.setAttribute("visibility", at.pin ? "visible" : "hidden")
      if (!at.pin) return
      item.dot.style.transform = `translate(${ax}px, ${ay}px)`
      const end = stemEnd({ x: ax, y: ay }, { x, y, w: item.w, h: item.h })
      item.stem.setAttribute("x1", String(ax))
      item.stem.setAttribute("y1", String(ay))
      item.stem.setAttribute("x2", String(end.x))
      item.stem.setAttribute("y2", String(end.y))
    })
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
