import { useEffect, useState } from "react"

// useState backed by localStorage (JSON). All keys share one namespace so the
// dashboard's whole UI/filter config round-trips across reloads.
const NS = "agent-mesh:"

export function usePersistedState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(NS + key)
      return raw != null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(NS + key, JSON.stringify(value))
    } catch {
      /* quota / private mode — ignore */
    }
  }, [key, value])

  return [value, setValue]
}
