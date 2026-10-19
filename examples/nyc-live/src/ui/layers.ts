// Layer toggles in terms of the URL's `layers` value: null shows every layer, a
// list shows only those.

const NAMES: Record<string, string> = {
  ground: "Ground",
  buildings: "Buildings",
  subway: "Subway",
  trains: "Trains",
  citibike: "Citi Bike",
  venue: "Venue pin",
}

export function layerName(id: string): string {
  return NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1)
}

export function isLayerShown(layers: readonly string[] | null, id: string): boolean {
  return layers == null || layers.includes(id)
}

// Shows or hides one layer. The result keeps the draw order of `all`, and is null
// again once every layer is on, so the default view keeps the shortest URL.
export function toggleLayer(layers: readonly string[] | null, all: readonly string[], id: string): string[] | null {
  const shown = new Set(layers ?? all)
  if (shown.has(id)) shown.delete(id)
  else shown.add(id)
  return all.every((l) => shown.has(l)) ? null : all.filter((l) => shown.has(l))
}

// The HUD's status line: each layer's summary, then the failure of any layer that did
// not start, until it recovers (a live layer that draws after a retry has a summary
// again, and is dropped from `failures`, layer id -> error). Quiet layers' summaries
// are left out: what they draw speaks for itself on screen.
export function statusLine(
  layers: ReadonlyArray<{ id: string; summary?(): string | null }>,
  failures: Map<string, string>,
  quiet: ReadonlySet<string> = new Set(),
): string {
  const parts: string[] = []
  for (const layer of layers) {
    const summary = layer.summary?.()
    if (summary == null || summary === "") continue
    failures.delete(layer.id)
    if (!quiet.has(layer.id)) parts.push(summary)
  }
  for (const [id, error] of failures) parts.push(`failed: ${id}: ${error}`)
  return parts.join(" · ") || "ready"
}
