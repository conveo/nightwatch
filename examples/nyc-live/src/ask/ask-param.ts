import type { AskQuestion } from "./types.ts"

// The panel's question is part of the view state (`ask` in the URL hash), so a link
// or a review note opens the panel with that question asked:
//
//   ask=route:brooklyn-bridge     the fastest way from the venue to a place
//   ask=line:F                    does a line run normally
//   ask=yesno:Are+there+e-bikes+near+the+venue%3F

export function parseAsk(raw: string | null): AskQuestion | null {
  if (raw == null) return null
  const colon = raw.indexOf(":")
  const value = raw.slice(colon + 1).trim()
  if (colon < 0 || value === "") return null
  switch (raw.slice(0, colon)) {
    case "route":
      return { template: "route", place: value }
    case "line":
      return { template: "line", line: value }
    case "yesno":
      return { template: "yesno", question: value }
    default:
      return null
  }
}

export function askParam(question: AskQuestion): string {
  switch (question.template) {
    case "route":
      return `route:${question.place}`
    case "line":
      return `line:${question.line}`
    case "yesno":
      return `yesno:${question.question}`
  }
}

export function percent(p: number): string {
  return `${Math.round(p * 100)}%`
}
