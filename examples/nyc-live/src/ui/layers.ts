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
