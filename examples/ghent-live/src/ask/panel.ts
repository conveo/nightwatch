import type { ViewState } from "../view-state.ts"

export type AskContext = {
  getView: () => ViewState
  // Applies a new view and writes it to the URL: the panel stores its question as
  // `ask` and highlights an answer (a garage, say) through `sel`.
  setView: (next: ViewState) => void
}

// "Ask Ghent": typed questions about the city's current state, answered by the
// OpenAI Decisions API through the dev server (/api/ask), so the key never reaches
// the browser. Owned by ticket T7 in plan/PLAN.md. Until then the panel stays hidden.
// Returns a promise that resolves once a question that came in the URL (`ask`) shows
// its answer, so a screenshot of that view waits for it.
export function mountAskPanel(_root: HTMLElement, _ctx: AskContext): Promise<void> {
  return Promise.resolve()
}
