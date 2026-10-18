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

// The scene selection (`sel`) that highlights an answer: a line answer selects its
// subway route, which the subway layer highlights while dimming the rest. Lines
// that share a track ("line:R/W") select the first. Other answers select nothing.
export function selectionFor(highlight: string | null): string | null {
  if (highlight == null || !highlight.startsWith("line:")) return null
  const line = highlight.slice(5).split("/")[0]
  return line == null || line === "" ? null : `route:${line}`
}

export function percent(p: number): string {
  return `${Math.round(p * 100)}%`
}
