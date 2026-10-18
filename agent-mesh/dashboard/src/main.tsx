import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"
import { useIsMobile } from "./lib/useIsMobile.ts"
import "./index.css"

// One URL, two shells: the desktop dashboard (Console / Roster / Plans) and a
// chat-first console on a phone. Both mount the same console modules; only the
// layout differs, and the branch lives here rather than inside App so neither shell
// can reach into the other's tree.
//
// Both halves are lazy so a phone never downloads the roster, the filter panel and
// the plan renderer it has no screen for — a second of nothing on every cold load
// over a tailnet link.
const App = lazy(() => import("./App.tsx"))
const MobileApp = lazy(() => import("./console/MobileApp.tsx"))

function Root() {
  const isMobile = useIsMobile()
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted-foreground">loading…</div>}>
      {isMobile ? <MobileApp /> : <App />}
    </Suspense>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
