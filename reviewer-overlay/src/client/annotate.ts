// Pin and stroke geometry shared by the live SVG and the screenshot canvas, so
// the image the agent gets shows the marker exactly where the reviewer saw it.

export const PIN_COLOR = "#ea580c"
export const PIN_RADIUS = 14

type Point = { x: number; y: number }

// A teardrop whose tip sits on (x, y): a circle above the point joined to the
// tip by its two tangent lines.
export function pinPath(args: { x: number; y: number; r: number }): { d: string; cx: number; cy: number } {
  const { x, y, r } = args
  const distance = r * 1.9
  const cy = y - distance
  const alpha = Math.acos(r / distance)
  const dx = r * Math.sin(alpha)
  const dy = cy + r * Math.cos(alpha)
  const d = `M ${x} ${y} L ${x - dx} ${dy} A ${r} ${r} 0 1 1 ${x + dx} ${dy} Z`
  return { d, cx: x, cy }
}

export function strokePath(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")
}

// Draws the annotations onto a frame of the viewport. Positions are viewport
// pixels; the frame can be a different size (device pixels, or a scaled
// capture), so everything is scaled by the frame-to-viewport ratio.
export function annotateFrame(args: {
  frame: HTMLCanvasElement
  viewport: { w: number; h: number }
  pin: { x: number; y: number; n: number } | null
  strokes: Point[][]
}): string {
  const { frame } = args
  const ctx = frame.getContext("2d")
  if (ctx == null) {
    return frame.toDataURL("image/png")
  }
  const sx = frame.width / args.viewport.w
  const sy = frame.height / args.viewport.h
  const scale = (sx + sy) / 2

  ctx.save()
  ctx.scale(sx, sy)
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  for (const stroke of args.strokes) {
    if (stroke.length === 0) {
      continue
    }
    const path = new Path2D(stroke.length === 1 ? `M ${stroke[0]?.x} ${stroke[0]?.y} l 0.01 0` : strokePath(stroke))
    ctx.strokeStyle = "rgba(255,255,255,0.85)"
    ctx.lineWidth = 6
    ctx.stroke(path)
    ctx.strokeStyle = PIN_COLOR
    ctx.lineWidth = 3
    ctx.stroke(path)
  }
  ctx.restore()

  if (args.pin != null) {
    const x = args.pin.x * sx
    const y = args.pin.y * sy
    const r = PIN_RADIUS * scale
    const { d, cx, cy } = pinPath({ x, y, r })
    const path = new Path2D(d)
    ctx.save()
    ctx.shadowColor = "rgba(0,0,0,0.35)"
    ctx.shadowBlur = 8 * scale
    ctx.shadowOffsetY = 2 * scale
    ctx.fillStyle = PIN_COLOR
    ctx.fill(path)
    ctx.restore()
    ctx.save()
    ctx.strokeStyle = "#ffffff"
    ctx.lineWidth = 2 * scale
    ctx.stroke(path)
    ctx.fillStyle = "#ffffff"
    ctx.font = `700 ${Math.round(13 * scale)}px system-ui, -apple-system, "Segoe UI", sans-serif`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(String(args.pin.n), cx, cy + 0.5 * scale)
    ctx.restore()
  }
  return frame.toDataURL("image/png")
}
