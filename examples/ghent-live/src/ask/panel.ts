import { PLACES, placeBySlug } from "../places.ts"
import type { ViewState } from "../view-state.ts"
import {
  formatAsk,
  parseAsk,
  questionText,
  titleCase,
  MAX_FREE_QUESTION,
  type AskAnswer,
  type AskFailure,
  type Names,
} from "./templates.ts"
import "./panel.css"

export type AskContext = {
  getView: () => ViewState
  // Applies a new view and writes it to the URL: the panel stores its question as
  // `ask` and highlights an answer (a garage, say) through `sel`.
  setView: (next: ViewState) => void
}

// On a phone the open panel needs at least this much height between the left-hand
// controls and the preset bar; with less it folds rather than cover either.
const MIN_PHONE_PANEL_PX = 160

// The panel gives up on an answer after this long, so a screenshot never waits forever.
export const ANSWER_TIMEOUT_MS = 8_000

// Questions offered as you type; anything else is asked as a free yes/no question.
const DRIVE_EXAMPLES = ["coupure~portus-ganda", "tolhuis~krook", "kuip~coupure"]
const SUGGESTIONS: string[] = [
  ...PLACES.map((p) => `park:${p.slug}`),
  "busy:now",
  ...DRIVE_EXAMPLES.map((d) => `drive:${d}`),
]

// The places are known here; sector names come from the server's city state, so until
// the answer arrives a sector shows as its slug in title case ("Portus Ganda").
const NAMES: Names = { place: (slug) => placeBySlug(slug)?.nl ?? null, sector: titleCase }
const textOf = (ask: string) => {
  const question = parseAsk(ask)
  return question == null ? ask : questionText(question, NAMES)
}
// Typed text matches a suggestion whatever its case and final question mark.
const key = (text: string) => text.trim().replace(/\s+/g, " ").replace(/\?$/, "").toLowerCase()

const pct = (p: number) => `${Math.round(p * 100)}%`
const dataTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Brussels",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
})

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text != null) node.textContent = text
  return node
}

function sourceLine(answer: AskAnswer): string {
  const when = `data of ${dataTime.format(new Date(answer.dataTime))}`
  switch (answer.source) {
    case "live":
      return `Live, ${answer.ms} ms · ${when}`
    case "recorded":
      return `Recorded answer · ${when}`
    case "cached":
      return `Cached answer · ${when}`
  }
}

// "Ask Ghent": typed questions about the city's current state, answered by the
// OpenAI Decisions API through the dev server (/api/ask), so the key never reaches
// the browser. Owned by ticket T7 in plan/PLAN.md.
// Returns a promise that resolves once a question that came in the URL (`ask`) shows
// its answer or its error, so a screenshot of that view waits for it (at most
// ANSWER_TIMEOUT_MS).
//
// With no question the panel folds to its title, a small "Ask Ghent" button, so it
// keeps the scene and the other controls clear; the title opens and folds it, and ×
// clears the question and folds it.
export function mountAskPanel(root: HTMLElement, ctx: AskContext): Promise<void> {
  root.replaceChildren()
  root.classList.add("ask-panel")
  root.setAttribute("aria-label", "Ask Ghent")

  const head = el("div", "ask-head")
  const title = el("h2", "ask-title")
  const toggle = el("button", "ask-toggle", "Ask Ghent")
  toggle.type = "button"
  toggle.setAttribute("aria-controls", "ask-body")
  title.append(toggle)
  const clear = el("button", "ask-clear", "×")
  clear.type = "button"
  clear.title = "Clear the question and close"
  clear.setAttribute("aria-label", "Clear the question and close")
  head.append(title, clear)

  const body = el("div", "ask-body")
  body.id = "ask-body"
  const result = el("section", "ask-result")
  result.setAttribute("aria-live", "polite")

  const form = el("form", "ask-form")
  const input = el("input", "ask-input")
  input.type = "text"
  input.name = "question"
  input.maxLength = MAX_FREE_QUESTION
  input.placeholder = "Ask a question…"
  input.autocomplete = "off"
  input.setAttribute("aria-label", "Your question")
  input.setAttribute("list", "ask-suggestions")
  const submit = el("button", "ask-submit", "Ask")
  submit.type = "submit"
  const list = el("datalist", "")
  list.id = "ask-suggestions"
  const byText = new Map<string, string>()
  for (const ask of SUGGESTIONS) {
    const text = textOf(ask)
    byText.set(key(text), ask)
    const option = document.createElement("option")
    option.value = text
    list.append(option)
  }
  form.append(input, submit, list)
  body.append(result, form)
  root.append(head, body)
  root.hidden = false

  let shown: string | null = null
  let seq = 0

  // On a phone the open panel fills the space between the left-hand controls (the
  // Day/Night switch and the layers) and the preset bar, so it never covers them; it
  // is measured again whenever either of them changes size. Opening it folds the layer
  // list first, and when the controls grow into its space (the layer list opened) the
  // panel folds instead of covering the preset bar.
  const narrow = window.matchMedia("(max-width: 760px)")
  function place(): void {
    if (!narrow.matches || root.dataset.state !== "open") {
      root.style.removeProperty("top")
      root.style.removeProperty("max-height")
      return
    }
    const above = document.querySelector(".ui-panel") ?? document.querySelector("#hud")
    const below = document.querySelector(".ui-presets")
    const top = Math.round((above?.getBoundingClientRect().bottom ?? 0) + 12)
    const bottom = Math.round((below?.getBoundingClientRect().top ?? window.innerHeight) - 12)
    if (bottom - top < MIN_PHONE_PANEL_PX) {
      setOpen(false)
      return
    }
    root.style.top = `${top}px`
    root.style.maxHeight = `${bottom - top}px`
  }
  const foldLayers = (): void => {
    if (narrow.matches) document.querySelector<HTMLButtonElement>('.ui-disclosure[aria-expanded="true"]')?.click()
  }
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(place)
    for (const selector of [".ui-panel", ".ui-presets", "#hud"]) {
      const node = document.querySelector(selector)
      if (node != null) observer.observe(node)
    }
  }
  window.addEventListener("resize", place)
  narrow.addEventListener("change", place)

  function setOpen(open: boolean): void {
    root.dataset.state = open ? "open" : "closed"
    toggle.setAttribute("aria-expanded", String(open))
    toggle.title = open ? "Fold the panel" : "Ask a question about the city"
    body.hidden = !open
    clear.hidden = !open
    place()
  }

  toggle.addEventListener("click", () => {
    const open = root.dataset.state !== "open"
    if (open) foldLayers()
    setOpen(open)
    if (open && shown == null) input.focus()
  })

  function renderEmpty(): void {
    result.replaceChildren(el("p", "ask-hint", "Where to park, whether the centre is busy, or any yes/no question."))
  }

  function renderPending(ask: string): void {
    result.replaceChildren(el("p", "ask-question", textOf(ask)), el("p", "ask-pending", "Asking…"))
  }

  function renderAnswer(answer: AskAnswer): void {
    const line = el("div", "ask-answer")
    line.append(el("span", "ask-headline", answer.answer), el("span", "ask-pct", pct(answer.probability)))
    // The other options with their probabilities open from the answer itself: on a
    // projector the answer reads best on its own.
    const others = answer.options.filter((o) => o.value !== answer.sel)
    let shownAnswer: HTMLElement = line
    if (others.length > 0) {
      const more = el("details", "ask-more")
      const summary = el("summary", "ask-more-summary")
      summary.title = "Show the other options"
      summary.append(line)
      const ol = el("ol", "ask-options")
      for (const option of others) {
        const li = el("li", "ask-option")
        li.style.setProperty("--p", String(option.probability))
        li.append(el("span", "ask-option-label", option.label), el("span", "ask-option-pct", pct(option.probability)))
        ol.append(li)
      }
      more.append(summary, ol)
      shownAnswer = more
    }
    result.replaceChildren(
      el("p", "ask-question", answer.question),
      shownAnswer,
      el("p", "ask-detail", answer.detail),
      ...(answer.notice == null ? [] : [el("p", "ask-notice", answer.notice)]),
      el("p", "ask-meta", sourceLine(answer)),
    )
  }

  function renderFailure(ask: string, failure: AskFailure): void {
    result.replaceChildren(
      el("p", "ask-question", failure.question ?? textOf(ask)),
      el("p", "ask-error", `No answer: ${failure.error}`),
    )
  }

  // Asks the server and shows what comes back. Resolves once something is on screen.
  async function ask(raw: string): Promise<void> {
    const mine = ++seq
    shown = raw
    renderPending(raw)
    const view = ctx.getView()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), ANSWER_TIMEOUT_MS)
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ask: raw, mode: view.mode, time: view.t }),
        signal: abort.signal,
      })
      const body = (await res.json()) as AskAnswer | AskFailure
      if (mine !== seq) return
      if (!res.ok || "error" in body) {
        renderFailure(raw, "error" in body ? body : { ask: raw, question: null, error: `HTTP ${res.status}` })
        return
      }
      renderAnswer(body)
      // Highlight the chosen garage or bike station, if the question is still the one asked.
      const now = ctx.getView()
      if (body.sel != null && now.ask === raw && now.sel !== body.sel) ctx.setView({ ...now, sel: body.sel })
    } catch (error) {
      if (mine !== seq) return
      const message =
        (error as Error).name === "AbortError" ? `no answer within ${ANSWER_TIMEOUT_MS / 1000} s` : "the server did not answer"
      renderFailure(raw, { ask: raw, question: null, error: message })
    } finally {
      clearTimeout(timer)
    }
  }

  function show(raw: string | null): Promise<void> {
    if (raw == null) {
      seq++
      shown = null
      renderEmpty()
      setOpen(false)
      return Promise.resolve()
    }
    foldLayers()
    setOpen(true)
    if (parseAsk(raw) == null) {
      seq++
      shown = raw
      renderFailure(raw, { ask: raw, question: null, error: "this is not a question the panel knows." })
      return Promise.resolve()
    }
    return ask(raw)
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault()
    const text = input.value.trim().replace(/\s+/g, " ")
    if (text === "") return
    const template = byText.get(key(text))
    const raw = template ?? formatAsk({ template: "q", text })
    input.value = ""
    input.blur()
    ctx.setView({ ...ctx.getView(), ask: raw })
    void show(raw)
  })

  clear.addEventListener("click", () => {
    ctx.setView({ ...ctx.getView(), ask: null })
    void show(null)
  })

  // A link or a review plan's step that changes the question asks the new one.
  window.addEventListener("hashchange", () => {
    const next = ctx.getView().ask
    if (next !== shown) void show(next)
  })

  return show(ctx.getView().ask)
}
