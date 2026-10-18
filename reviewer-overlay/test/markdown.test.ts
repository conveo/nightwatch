import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseBlocks, parseInline, safeHref } from "../src/client/markdown.ts"

describe("markdown subset", () => {
  it("tokenises bold, code and links", () => {
    assert.deepEqual(parseInline("Open **Settings**, run `ls` and see [docs](https://example.com)."), [
      { type: "text", text: "Open " },
      { type: "bold", text: "Settings" },
      { type: "text", text: ", run " },
      { type: "code", text: "ls" },
      { type: "text", text: " and see " },
      { type: "link", text: "docs", href: "https://example.com" },
      { type: "text", text: "." },
    ])
  })

  it("keeps markup characters as plain text", () => {
    assert.deepEqual(parseInline("<img src=x onerror=alert(1)>"), [{ type: "text", text: "<img src=x onerror=alert(1)>" }])
  })

  it("groups list lines", () => {
    assert.deepEqual(parseBlocks("Intro\n- a\n- b\n1. c\n2. d\nEnd"), [
      { type: "para", text: "Intro" },
      { type: "ul", items: ["a", "b"] },
      { type: "ol", items: ["c", "d"] },
      { type: "para", text: "End" },
    ])
  })

  it("only allows http, https and mailto links", () => {
    assert.equal(safeHref({ href: "javascript:alert(1)", base: "http://localhost:3000/" }), null)
    assert.equal(safeHref({ href: "data:text/html,x", base: "http://localhost:3000/" }), null)
    assert.equal(safeHref({ href: "/settings", base: "http://localhost:3000/a" }), "http://localhost:3000/settings")
    assert.equal(safeHref({ href: "mailto:a@b.c", base: "http://localhost:3000/" }), "mailto:a@b.c")
  })
})
