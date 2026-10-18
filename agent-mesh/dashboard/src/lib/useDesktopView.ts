import { usePersistedState } from "./usePersistedState"

// Console first, and the default: talking to the mesh is what you want on open, and
// the roster is what you want when you already know which agent you are chasing.
export const DESKTOP_VIEWS = [
  { id: "console", label: "Console" },
  { id: "roster", label: "Roster" },
  { id: "plans", label: "Plans" },
] as const

export type DesktopView = (typeof DESKTOP_VIEWS)[number]["id"]

const KEY = "view-v2"
const LEGACY_KEY = "agent-mesh:view"

/**
 * The selected tab, persisted — with a one-time read of the old two-tab key.
 *
 * The migration is not cosmetic. `usePersistedState` writes on mount, so the old
 * `view` key holds "roster" for everyone who ever opened the dashboard, whether they
 * chose it or it was simply the default. That value is therefore NOT evidence of a
 * preference, and honouring it would mean nobody ever lands on the new default.
 * "plans" is different: it could only ever have been reached by clicking, so it is a
 * real choice and is carried over. Everything else starts on the console, and the
 * first deliberate click writes the new key and settles it for good.
 */
export function useDesktopView(): [DesktopView, (v: DesktopView) => void] {
  const [view, setView] = usePersistedState<DesktopView>(KEY, legacyChoice() ?? "console")
  return [view, setView]
}

function legacyChoice(): DesktopView | null {
  try {
    return localStorage.getItem(LEGACY_KEY) === '"plans"' ? "plans" : null
  } catch {
    return null // quota / private mode — treat as no stored preference
  }
}
