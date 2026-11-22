// The questions "ask Ghent" understands, as they live in the URL (`ask=<template>:<value>`,
// see plan/PLAN.md, "Contracts"). Shared by the panel and by the server route, so
// both read a question the same way. No DOM and no Node here.
//
//   park:gravensteen            Where should I park to reach Gravensteen?    (choice)
//   drive:coupure~portus-ganda  Can I drive from Coupure to Portus Ganda
//                               without leaving the R40 ring road?           (predicate)
//   busy:now                    Is the centre busy right now?                (predicate)
//   q:<text>                    a free yes/no question about the city now    (predicate)
//
// A free question is one value in the hash, URL-encoded like any other (spaces
// become "+"): `ask=q:Is+there+space+at+Sint-Michiels%3F`.

export type AskQuestion =
  | { template: "park"; place: string }
  | { template: "drive"; from: string; to: string }
  | { template: "busy" }
  | { template: "q"; text: string }

export const MAX_FREE_QUESTION = 200

// Slugs are lower case, ASCII, words joined by "-", the same rule as the parking
// layer's (T5): NFKD, diacritics stripped, lower case, every run of characters outside
// [a-z0-9] becomes one "-", none leading or trailing. "Sint-Michiels" → "sint-michiels",
// "P+R The Loop" → "p-r-the-loop", "The Loop - Parking D" → "the-loop-parking-d",
// "François" → "francois".
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
    .join("-")
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// The syntax only: whether the place or the sectors exist is the server's call,
// because it holds the city state. Returns null for anything it does not know.
export function parseAsk(raw: string | null | undefined): AskQuestion | null {
  if (raw == null) return null
  const colon = raw.indexOf(":")
  if (colon < 0) return null
  const template = raw.slice(0, colon)
  const value = raw.slice(colon + 1)
  switch (template) {
    case "park":
      return SLUG.test(value) ? { template: "park", place: value } : null
    case "drive": {
      const [from, to, ...rest] = value.split("~")
      if (from == null || to == null || rest.length > 0 || !SLUG.test(from) || !SLUG.test(to)) return null
      return { template: "drive", from, to }
    }
    case "busy":
      return value === "now" ? { template: "busy" } : null
    case "q": {
      const text = value.trim().replace(/\s+/g, " ")
      return text !== "" && text.length <= MAX_FREE_QUESTION ? { template: "q", text } : null
    }
    default:
      return null
  }
}

export function formatAsk(question: AskQuestion): string {
  switch (question.template) {
    case "park":
      return `park:${question.place}`
    case "drive":
      return `drive:${question.from}~${question.to}`
    case "busy":
      return "busy:now"
    case "q":
      return `q:${question.text}`
  }
}

// Names for the slugs in a question. The server passes the real ones; the panel,
// before the answer arrives, falls back to the slug in title case.
export type Names = { place(slug: string): string | null; sector(slug: string): string | null }

export function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

const FALLBACK: Names = { place: titleCase, sector: titleCase }

export function questionText(question: AskQuestion, names: Names = FALLBACK): string {
  switch (question.template) {
    case "park":
      return `Where should I park to reach ${names.place(question.place) ?? titleCase(question.place)}?`
    case "drive": {
      const from = names.sector(question.from) ?? titleCase(question.from)
      const to = names.sector(question.to) ?? titleCase(question.to)
      return `Can I drive from ${from} to ${to} without leaving the R40 ring road?`
    }
    case "busy":
      return "Is the centre busy right now?"
    case "q":
      return /[?.!]$/.test(question.text) ? question.text : `${question.text}?`
  }
}

// What POST /api/ask takes and returns. Percentages are 0 to 1.
export type AskRequest = { ask: string; mode: "fixture" | "recorded" | "live"; time: string | null }

export type AskOption = { value: string; label: string; detail: string; probability: number }

export type AskAnswer = {
  ask: string
  question: string
  kind: "choice" | "predicate"
  // The headline ("Vrijdagmarkt", "No") and how likely the Decisions API finds it.
  answer: string
  probability: number
  detail: string
  // The selection the answer points at (`garage:<slug>`, `bikes:<operator>:<id>`), or null.
  sel: string | null
  // For a choice, every option with its probability, most likely first.
  options: AskOption[]
  // "live": asked the Decisions API now; "recorded": a committed answer, because the
  // server has no key; "cached": the same question on the same data a moment ago.
  source: "live" | "recorded" | "cached"
  dataTime: string
  ms: number
}

export type AskFailure = { ask: string; question: string | null; error: string }
