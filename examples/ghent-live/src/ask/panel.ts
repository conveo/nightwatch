import { PLACES } from "../places.ts"
import type { ViewState } from "../view-state.ts"
import { formatAsk, parseAsk, questionText, MAX_FREE_QUESTION, type AskAnswer, type AskFailure } from "./templates.ts"
import "./panel.css"

export type AskContext = {
  getView: () => ViewState
  // Applies a new view and writes it to the URL: the panel stores its question as
  // `ask` and highlights an answer (a garage, say) through `sel`.
  setView: (next: ViewState) => void
}

// The panel gives up on an answer after this long, so a screenshot never waits forever.
export const ANSWER_TIMEOUT_MS = 8_000

// Questions offered as you type; anything else is asked as a free yes/no question.
const DRIVE_EXAMPLES = ["coupure~portus-ganda", "tolhuis~krook", "kuip~coupure"]
const SUGGESTIONS: string[] = [
  ...PLACES.map((p) => `park:${p.slug}`),
  "busy:now",
  ...DRIVE_EXAMPLES.map((d) => `drive:${d}`),
]

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
      return `Decisions API, ${answer.ms} ms · ${when}`
    case "recorded":
      return `Recorded answer · ${when}`
    case "cached":
      return `Asked a moment ago · ${when}`
  }
}

// "Ask Ghent": typed questions about the city's current state, answered by the
// OpenAI Decisions API through the dev server (/api/ask), so the key never reaches
// the browser. Owned by ticket T7 in plan/PLAN.md.
// Returns a promise that resolves once a question that came in the URL (`ask`) shows
// its answer or its error, so a screenshot of that view waits for it (at most
// ANSWER_TIMEOUT_MS).
export function mountAskPanel(root: HTMLElement, ctx: AskContext): Promise<void> {
  root.replaceChildren()
  root.classList.add("ask-panel")
  root.setAttribute("aria-label", "Ask Ghent")

  const head = el("div", "ask-head")
  const title = el("h2", "ask-title", "Ask Ghent")
  const clear = el("button", "ask-clear", "×")
  clear.type = "button"
  clear.title = "Clear the question"
  clear.setAttribute("aria-label", "Clear the question")
  head.append(title, clear)

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
    const text = questionText(parseAsk(ask)!)
    byText.set(text.toLowerCase(), ask)
    const option = document.createElement("option")
    option.value = text
    list.append(option)
  }
  form.append(input, submit, list)
  root.append(head, result, form)
  root.hidden = false

  let shown: string | null = null
  let seq = 0

  function renderEmpty(): void {
    result.replaceChildren(el("p", "ask-hint", "Where to park, whether the centre is busy, or any yes/no question."))
    clear.hidden = true
  }

  function renderPending(ask: string): void {
    const question = parseAsk(ask)
    result.replaceChildren(
      el("p", "ask-question", question == null ? ask : questionText(question)),
      el("p", "ask-pending", "Asking…"),
    )
    clear.hidden = false
  }

  function renderAnswer(answer: AskAnswer): void {
    const line = el("div", "ask-answer")
    line.append(el("span", "ask-headline", answer.answer), el("span", "ask-pct", pct(answer.probability)))
    const nodes: HTMLElement[] = [el("p", "ask-question", answer.question), line, el("p", "ask-detail", answer.detail)]
    const others = answer.options.filter((o) => o.value !== answer.sel)
    if (others.length > 0) {
      const ol = el("ol", "ask-options")
      for (const option of others) {
        const li = el("li", "ask-option")
        li.style.setProperty("--p", String(option.probability))
        li.append(el("span", "ask-option-label", option.label), el("span", "ask-option-pct", pct(option.probability)))
        ol.append(li)
      }
      nodes.push(ol)
    }
    nodes.push(el("p", "ask-meta", sourceLine(answer)))
    result.replaceChildren(...nodes)
    clear.hidden = false
  }

  function renderFailure(ask: string, failure: AskFailure): void {
    const question = parseAsk(ask)
    result.replaceChildren(
      el("p", "ask-question", failure.question ?? (question == null ? ask : questionText(question))),
      el("p", "ask-error", `No answer: ${failure.error}`),
    )
    clear.hidden = false
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
      return Promise.resolve()
    }
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
    const template = byText.get(text.toLowerCase())
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
