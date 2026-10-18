// A small markdown subset for plan prose: **bold**, `code`, [links](url) and
// "-" / "1." lists. Output is built with text nodes only, never innerHTML, so
// a plan cannot inject markup into the page.

export type InlineToken =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string }

export type Block =
  | { type: "para"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index
    if (index > last) {
      tokens.push({ type: "text", text: text.slice(last, index) })
    }
    const [, bold, code, linkText, href] = match
    if (bold != null) {
      tokens.push({ type: "bold", text: bold })
    } else if (code != null) {
      tokens.push({ type: "code", text: code })
    } else if (linkText != null && href != null) {
      tokens.push({ type: "link", text: linkText, href })
    }
    last = index + match[0].length
  }
  if (last < text.length) {
    tokens.push({ type: "text", text: text.slice(last) })
  }
  return tokens
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line === "") {
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line)
    const previous = blocks[blocks.length - 1]
    if (bullet?.[1] != null) {
      if (previous?.type === "ul") {
        previous.items.push(bullet[1])
      } else {
        blocks.push({ type: "ul", items: [bullet[1]] })
      }
      continue
    }
    if (numbered?.[1] != null) {
      if (previous?.type === "ol") {
        previous.items.push(numbered[1])
      } else {
        blocks.push({ type: "ol", items: [numbered[1]] })
      }
      continue
    }
    blocks.push({ type: "para", text: line })
  }
  return blocks
}

// Only http(s) and mailto links become anchors; anything else renders as text.
export function safeHref(args: { href: string; base: string }): string | null {
  let url: URL
  try {
    url = new URL(args.href, args.base)
  } catch {
    return null
  }
  return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null
}

function renderInline(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const token of parseInline(text)) {
    switch (token.type) {
      case "text":
        fragment.append(document.createTextNode(token.text))
        break
      case "bold": {
        const strong = document.createElement("strong")
        strong.textContent = token.text
        fragment.append(strong)
        break
      }
      case "code": {
        const code = document.createElement("code")
        code.textContent = token.text
        fragment.append(code)
        break
      }
      case "link": {
        const href = safeHref({ href: token.href, base: location.href })
        if (href == null) {
          fragment.append(document.createTextNode(token.text))
          break
        }
        const anchor = document.createElement("a")
        anchor.href = href
        anchor.target = "_blank"
        anchor.rel = "noopener noreferrer"
        anchor.textContent = token.text
        fragment.append(anchor)
        break
      }
    }
  }
  return fragment
}

export function renderMarkdown(text: string): HTMLElement {
  const container = document.createElement("div")
  container.className = "md"
  for (const block of parseBlocks(text)) {
    switch (block.type) {
      case "para": {
        const para = document.createElement("p")
        para.append(renderInline(block.text))
        container.append(para)
        break
      }
      case "ul":
      case "ol": {
        const list = document.createElement(block.type)
        for (const item of block.items) {
          const li = document.createElement("li")
          li.append(renderInline(item))
          list.append(li)
        }
        container.append(list)
        break
      }
    }
  }
  return container
}
