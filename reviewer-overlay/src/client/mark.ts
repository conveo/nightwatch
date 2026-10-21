// The agent-mesh mark, inlined from agent-mesh/dashboard/public/agentmesh-mark.svg
// so the overlay needs no extra request. Agents orbit on three rings around a
// pulsing core. The gradient ids get a suffix because the mark appears more than
// once in the same shadow root; test/mark.test.ts keeps this copy in step with
// the file.
export function meshMarkSvg(suffix: string): string {
  const m = `m-${suffix}`
  const c = `c-${suffix}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
  <defs>
    <linearGradient id="${m}" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#F2B441"/>
      <stop offset="1" stop-color="#E55425"/>
    </linearGradient>
    <radialGradient id="${c}" cx="12" cy="12" r="3" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFD884"/>
      <stop offset="1" stop-color="#F2B441"/>
    </radialGradient>
  </defs>
  <circle cx="12" cy="12" r="9" stroke="url(#${m})" stroke-width="0.8" opacity="0.6" fill="none"/>
  <circle r="1.4" fill="#FFCB72"><animateMotion dur="10s" repeatCount="indefinite" path="M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0Z"/></circle>
  <g transform="rotate(45 12 12)">
    <g stroke="url(#${m})" stroke-width="0.8" fill="none">
      <ellipse cx="12" cy="12" rx="9" ry="3.4" opacity="0.55"/>
      <ellipse cx="12" cy="12" rx="3.4" ry="9" opacity="0.55"/>
    </g>
    <g fill="#FFCB72">
      <circle r="1.6"><animateMotion dur="6s" repeatCount="indefinite" path="M3 12a9 3.4 0 1 0 18 0a9 3.4 0 1 0-18 0Z"/></circle>
      <circle r="1.25"><animateMotion dur="6s" begin="-3s" repeatCount="indefinite" path="M3 12a9 3.4 0 1 0 18 0a9 3.4 0 1 0-18 0Z"/></circle>
      <circle r="1.6"><animateMotion dur="7.4s" repeatCount="indefinite" path="M12 3a3.4 9 0 1 0 0 18a3.4 9 0 1 0 0-18Z"/></circle>
      <circle r="1.25"><animateMotion dur="7.4s" begin="-3.7s" repeatCount="indefinite" path="M12 3a3.4 9 0 1 0 0 18a3.4 9 0 1 0 0-18Z"/></circle>
    </g>
  </g>
  <circle cx="12" cy="12" r="2.6" fill="#F2B441" opacity="0.22">
    <animate attributeName="opacity" values="0.14;0.34;0.14" dur="3.2s" repeatCount="indefinite"/>
    <animate attributeName="r" values="2.2;2.9;2.2" dur="3.2s" repeatCount="indefinite"/>
  </circle>
  <circle cx="12" cy="12" r="1.55" fill="url(#${c})"/>
</svg>`
}

// The markup is a constant, never page or user input, so parsing it is safe.
export function meshMark(args: { suffix: string; className: string }): Element {
  const parsed = new DOMParser().parseFromString(meshMarkSvg(args.suffix), "image/svg+xml").documentElement
  const mark = document.importNode(parsed, true)
  mark.setAttribute("class", args.className)
  mark.setAttribute("aria-hidden", "true")
  mark.setAttribute("focusable", "false")
  return mark
}
