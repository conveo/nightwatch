import { svg } from "./dom.ts"

// Line icons for the overlay's buttons, on a 16px grid, drawn in currentColor.
const ICONS = {
  close: ["M4.5 4.5l7 7", "M11.5 4.5l-7 7"],
  reload: ["M12.75 8a4.75 4.75 0 1 1-1.4-3.36", "M12.75 2.75v2.5h-2.5"],
  pin: ["M8 14s4.25-3.9 4.25-7.25a4.25 4.25 0 0 0-8.5 0C3.75 10.1 8 14 8 14z", "M9.6 6.75a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0z"],
  pen: ["M10.25 2.75l3 3L6 13H3v-3z", "M8.75 4.25l3 3"],
  plan: ["M4 1.75h5.25l2.75 2.75v9.75H4z", "M9.25 1.75v2.75H12", "M6 8.25h4", "M6 10.75h4"],
} as const

export type IconName = keyof typeof ICONS

export function icon(name: IconName): SVGSVGElement {
  const root = svg("svg", {
    class: "icon",
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  })
  for (const d of ICONS[name]) {
    root.append(svg("path", { d }))
  }
  return root
}
