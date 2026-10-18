// Plans are written by agents (and arrive on branches other agents pushed), so
// their HTML is untrusted, yet it is rendered into the dashboard's own origin,
// which can publish and unregister on the mesh. Everything the Plans tab puts
// into the DOM goes through this sanitizer, markdown output included.
//
// The page's CSP (script-src 'self', set by ui-server) is the second layer; it
// does not apply under the vite dev server, so this is the only layer there.
//
// The purifier is passed in (see plan-html.ts for the browser one) so that
// agent-mesh's node tests can run this exact configuration against jsdom.

import type { DOMPurify } from "dompurify"
import { renderMarkdown } from "./plan-markdown.ts"

export type PlanFormat = "markdown" | "html"

export function createPlanSanitizer(purify: DOMPurify): (args: { format: PlanFormat; content: string }) => string {
  // A plan's links open in a new tab; without noopener the opened page gets a
  // handle on the dashboard window.
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.getAttribute("target") === "_blank") {
      node.setAttribute("rel", "noopener noreferrer")
    }
  })
  return ({ format, content }) =>
    purify.sanitize(format === "html" ? content : renderMarkdown(content), {
      // An HTML plan's <style> is either in <head> or (the recommended fragment
      // form) first in the file, which the parser hoists into <head> too.
      // Without WHOLE_DOCUMENT the head is dropped and every plan renders
      // unstyled; the fragment parser that receives the result keeps the
      // <style> elements and discards the html/head/body wrappers.
      WHOLE_DOCUMENT: format === "html",
      ADD_ATTR: ["target"],
      // A form in a plan could otherwise post to the dashboard's own API.
      FORBID_TAGS: ["form"],
    })
}
