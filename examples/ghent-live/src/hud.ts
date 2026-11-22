import type { Layer } from "./layers/types.ts"

// The HUD's status line: only what needs saying. Layers raise notices (data that
// may not be current, data that is missing) and a layer that failed to load says
// so until it draws after all. When there is nothing to say the line is empty, and
// main.ts hides it. No DOM here, so the tests run it directly.
export function statusLine(layers: Pick<Layer, "id" | "notice">[], failures: ReadonlyMap<string, string>): string {
  const notices = layers.map((l) => l.notice?.() ?? null).filter((n): n is string => n != null && n !== "")
  const failed = [...failures].map(([id, reason]) => `${id} failed: ${reason}`)
  return [...notices, ...failed].join(" · ")
}

// Damping keeps the camera gliding for seconds after the pointer is released, so the
// URL follows it while it moves (at most every `everyMs`), and once more when it
// stops, not only when the drag ends.
export function followCamera(
  save: () => void,
  everyMs = 250,
  now: () => number = () => Date.now(),
): { moved(): void; ended(): void } {
  let last = -Infinity
  let trailing: ReturnType<typeof setTimeout> | undefined
  const saveNow = (): void => {
    clearTimeout(trailing)
    trailing = undefined
    last = now()
    save()
  }
  return {
    moved() {
      if (now() - last >= everyMs) saveNow()
      clearTimeout(trailing)
      trailing = setTimeout(saveNow, everyMs)
    },
    ended: saveNow,
  }
}
