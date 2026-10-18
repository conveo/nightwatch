// Entry for the classic <script> build. It reads its settings from the script
// tag and starts the overlay:
//
//   <script src="http://127.0.0.1:4848/reviewer-overlay.js" defer></script>
//
// data-server  review server base URL (default: the origin the script came from)
// data-capture "none" to send without screenshots
// data-open    "true" to start with the panel open
// data-auto    "false" to only expose window.ReviewerOverlay.init
import { destroy, init } from "./index.ts"

declare global {
  interface Window {
    ReviewerOverlay?: { init: typeof init; destroy: typeof destroy }
  }
}

// currentScript is only set while this file runs, so it is read up front.
const script = document.currentScript instanceof HTMLScriptElement ? document.currentScript : null

window.ReviewerOverlay = { init, destroy }

if (script != null && script.dataset.auto !== "false") {
  const server = script.dataset.server ?? new URL(script.src, location.href).origin
  init({
    server,
    capture: script.dataset.capture === "none" ? "none" : "display-media",
    startOpen: script.dataset.open === "true",
  })
}
