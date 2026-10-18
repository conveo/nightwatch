import type { ViewState } from "../view-state.ts"

// "Ask the city": typed questions about the live state, answered by the OpenAI
// Decisions API through the dev server (/api/ask), so the key never reaches the
// browser. Owned by ticket T6 in plan/PLAN.md. Until then the panel stays hidden.
export function mountAskPanel(_root: HTMLElement, _getView: () => ViewState): void {}
