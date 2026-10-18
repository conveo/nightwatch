import type { CaptureMode, CustomCapture } from "./capture.ts"
import { createOverlay } from "./overlay.ts"

export type { CaptureMode, CustomCapture }

export type InitOptions = {
  // Base URL of the local review server, e.g. "http://127.0.0.1:4848".
  server: string
  // "display-media" (default) asks to share the tab once per comment session.
  // "none" sends notes without a screenshot. A function returns a PNG data URL
  // of the viewport; it runs while the overlay is hidden.
  capture?: CaptureMode
  startOpen?: boolean
}

type Handle = { destroy: () => void }

let current: Handle | null = null
let pending: InitOptions | null = null

function start(options: InitOptions): Handle {
  const handle = createOverlay({
    server: options.server,
    capture: options.capture ?? "display-media",
    startOpen: options.startOpen ?? false,
  })
  current = handle
  return handle
}

// Calling init twice keeps the first overlay.
export function init(options: InitOptions): void {
  if (current != null || pending != null) {
    return
  }
  if (document.body != null) {
    start(options)
    return
  }
  pending = options
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      const queued = pending
      pending = null
      if (queued != null && current == null) {
        start(queued)
      }
    },
    { once: true },
  )
}

export function destroy(): void {
  pending = null
  current?.destroy()
  current = null
}
