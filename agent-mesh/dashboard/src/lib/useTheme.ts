import { useEffect, useState } from "react"

export type Theme = "light" | "dark"
const KEY = "agent-mesh-theme"

// The initial class is applied by the inline script in index.html (no flash);
// this hook just reflects + flips it, persisting the choice.
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  )

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
    document.documentElement.style.colorScheme = theme
    localStorage.setItem(KEY, theme)
  }, [theme])

  return { theme, toggle: () => setTheme((t) => (t === "light" ? "dark" : "light")) }
}
