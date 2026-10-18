import { parseViewState, serializeViewState, type ViewState } from "../view-state.ts"
import { askParam, parseAsk, percent } from "./ask-param.ts"
import type { AskOptions, AskQuestion, AskResponse, AskTemplate } from "./types.ts"
import { YESNO_MAX_LENGTH } from "./types.ts"
import "./panel.css"

// "Ask the city": typed questions about the live state, answered by the OpenAI
// Decisions API through the dev server (/api/ask), so the key never reaches the
// browser. The panel shows the question, the most likely answer with its
// probability, and the runners-up.

const TEMPLATES: Array<{ id: AskTemplate; label: string }> = [
  { id: "route", label: "Fastest way to…" },
  { id: "line", label: "Is a line running normally?" },
  { id: "yesno", label: "Yes or no…" },
]

const SOURCE_LABELS: Record<string, string> = { fixture: "fixture data", recorded: "recorded", live: "live" }

// A question in the URL counts as part of the view, but a slow answer must not hold
// the app back for long.
const SETTLE_LIMIT_MS = 5000

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

// Mounts the panel and, when the URL holds a question, asks it. The promise settles
// once that first answer (or error) is on screen, so a caller can wait for it
// before reporting the view as ready.
export function mountAskPanel(root: HTMLElement, getView: () => ViewState): Promise<void> {
  root.classList.add("ask-panel")
  root.hidden = false

  const source = el("span", { className: "ask-source" })
  const template = el(
    "select",
    { name: "template", ariaLabel: "Question" },
    ...TEMPLATES.map((t) => el("option", { value: t.id, textContent: t.label })),
  )
  const place = el("select", { name: "place", ariaLabel: "Place" })
  const line = el("select", { name: "line", ariaLabel: "Line" })
  const text = el("input", {
    name: "question",
    type: "text",
    ariaLabel: "Yes or no question",
    placeholder: "Are there e-bikes near the venue?",
    maxLength: YESNO_MAX_LENGTH,
  })
  const submit = el("button", { type: "submit", textContent: "Ask" })
  const form = el("form", { className: "ask-form" }, template, el("div", { className: "ask-row" }, place, line, text, submit))

  const question = el("p", { className: "ask-question" })
  const answer = el("p", { className: "ask-answer" })
  const bar = el("div", { className: "ask-bar" })
  const others = el("ul", { className: "ask-others" })
  const result = el("div", { className: "ask-result" }, question, answer, bar, others)
  result.hidden = true
  const status = el("p", { className: "ask-status", role: "status" })

  root.replaceChildren(el("div", { className: "ask-head" }, el("h2", { textContent: "Ask the city" }), source), form, result, status)

  let colors = new Map<string, string>()
  let inFlight: AbortController | null = null
  // The question last asked (as in the URL), so a hash change that keeps it does
  // not ask again.
  let asked = getView().ask

  function showTemplate(): void {
    place.hidden = template.value !== "route"
    line.hidden = template.value !== "line"
    text.hidden = template.value !== "yesno"
  }
  template.addEventListener("change", showTemplate)
  showTemplate()

  function fillForm(q: AskQuestion): void {
    template.value = q.template
    if (q.template === "route") place.value = q.place
    if (q.template === "line") line.value = q.line.toUpperCase()
    if (q.template === "yesno") text.value = q.question
    showTemplate()
  }

  function readForm(): AskQuestion | null {
    switch (template.value as AskTemplate) {
      case "route":
        return place.value === "" ? null : { template: "route", place: place.value }
      case "line":
        return line.value === "" ? null : { template: "line", line: line.value }
      case "yesno":
        return text.value.trim() === "" ? null : { template: "yesno", question: text.value.trim() }
    }
  }

  function bullet(highlight: string | null): Node | null {
    const id = highlight?.startsWith("line:") ? highlight.slice(5) : null
    if (id == null) return null
    const b = el("span", { className: "ask-bullet", textContent: id })
    b.style.background = colors.get(id) ?? "#808183"
    return b
  }

  function showAnswer(r: AskResponse): void {
    source.textContent = SOURCE_LABELS[r.state.source] ?? r.state.source
    question.textContent = r.question
    if (r.answer == null || r.probability == null) {
      answer.replaceChildren(el("span", { className: "ask-answer-text", textContent: "No answer" }))
      bar.replaceChildren()
      others.replaceChildren()
    } else {
      const lead = bullet(r.highlight)
      answer.replaceChildren(
        ...(lead == null ? [] : [lead]),
        el("span", { className: "ask-answer-text", textContent: r.answer }),
        el("span", { className: "ask-pct", textContent: percent(r.probability) }),
      )
      const fill = el("div")
      fill.style.width = percent(r.probability)
      bar.replaceChildren(fill)
      others.replaceChildren(
        ...r.options
          .slice(1, 4)
          .map((o) => el("li", {}, el("span", { textContent: o.value }), el("span", { textContent: percent(o.probability) }))),
      )
    }
    result.hidden = false
    status.textContent = ""
  }

  async function ask(q: AskQuestion): Promise<void> {
    inFlight?.abort()
    const controller = new AbortController()
    inFlight = controller
    const view = getView()
    status.textContent = "Asking…"
    submit.disabled = true
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...q, mode: view.mode, t: view.t }),
        signal: controller.signal,
      })
      const body = (await res.json()) as AskResponse | { error: string }
      if (controller !== inFlight) return
      if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`)
      showAnswer(body)
    } catch (error) {
      if (controller !== inFlight) return
      status.textContent = `Could not ask: ${(error as Error).message}`
    } finally {
      if (controller === inFlight) {
        inFlight = null
        submit.disabled = false
      }
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault()
    const q = readForm()
    if (q == null) return
    // Put the question in the URL with the rest of the view. A fragment navigation
    // fires hashchange, so main.ts takes it into its view state; replace() keeps
    // one history entry, like main.ts's own URL updates.
    asked = askParam(q)
    location.replace(serializeViewState({ ...getView(), ask: asked }))
    void ask(q)
  })

  window.addEventListener("hashchange", () => {
    const raw = parseViewState(location.hash).ask
    if (raw === asked) return
    asked = raw
    const q = parseAsk(raw)
    if (q == null) return
    fillForm(q)
    void ask(q)
  })

  async function start(): Promise<void> {
    const view = getView()
    const params = new URLSearchParams({ mode: view.mode, ...(view.t == null ? {} : { t: view.t }) })
    try {
      const res = await fetch(`/api/ask?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const options = (await res.json()) as AskOptions
      place.replaceChildren(...options.places.map((p) => el("option", { value: p.id, textContent: p.name })))
      line.replaceChildren(
        ...options.lines.map((l) => el("option", { value: l.id, textContent: `${l.id} train${l.status === "normal" ? "" : ` (${l.status})`}` })),
      )
      colors = new Map(options.lines.map((l) => [l.id, l.color]))
      source.textContent = SOURCE_LABELS[options.state.source] ?? options.state.source
    } catch (error) {
      status.textContent = `Could not load the city: ${(error as Error).message}`
      return
    }
    const q = parseAsk(getView().ask)
    if (q == null) return
    fillForm(q)
    await ask(q)
  }

  return Promise.race([start(), new Promise<void>((resolve) => setTimeout(resolve, SETTLE_LIMIT_MS))])
}
