// Storage can throw (private windows, blocked site data). Every read falls back
// to the default and every write is best effort.

type Area = "local" | "session"

function area(which: Area): Storage | null {
  try {
    return which === "local" ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}

export function readJson<T>(args: { area: Area; key: string; fallback: T; isValid: (value: unknown) => value is T }): T {
  try {
    const raw = area(args.area)?.getItem(args.key)
    if (raw == null) {
      return args.fallback
    }
    const parsed: unknown = JSON.parse(raw)
    return args.isValid(parsed) ? parsed : args.fallback
  } catch {
    return args.fallback
  }
}

export function writeJson(args: { area: Area; key: string; value: unknown }): void {
  try {
    area(args.area)?.setItem(args.key, JSON.stringify(args.value))
  } catch {
    // Best effort.
  }
}

export const KEY_PREFIX = "reviewer-overlay:"
