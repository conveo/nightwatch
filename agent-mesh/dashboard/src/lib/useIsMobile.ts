import { useEffect, useState } from "react"

// Landing on this box should open the phone console on a phone and the desktop
// dashboard everywhere else.
//
// Width alone is wrong in both directions: a narrowed desktop window is still a
// desktop (mouse, keyboard, a roster that wants the space), and a tablet in
// portrait is not a phone. So both a small viewport AND a coarse pointer are
// required — and `?mobile=1` / `?mobile=0` overrides either way, which is the only
// way to exercise the phone build from a laptop.
const MOBILE_MAX_WIDTH = 820

function forcedFromQuery(): boolean | null {
  const raw = new URLSearchParams(window.location.search).get("mobile")
  if (raw === "1" || raw === "true") {
    return true
  }
  if (raw === "0" || raw === "false") {
    return false
  }
  return null
}

function detect(): boolean {
  const forced = forcedFromQuery()
  if (forced != null) {
    return forced
  }
  return window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`).matches && window.matchMedia("(pointer: coarse)").matches
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(detect)

  useEffect(() => {
    // Rotating a phone changes the width query; a forced override pins it and the
    // listener is then just a no-op that keeps the branch uniform.
    const mql = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`)
    const onChange = () => setIsMobile(detect())
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}
