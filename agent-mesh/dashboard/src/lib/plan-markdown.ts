// Compact GFM-ish markdown renderer for the Plans tab (shared shape with the
// plan-review tool). No imports, so agent-mesh's node test runner can load it.
//
// Its output still goes through the plan sanitizer before it reaches the DOM,
// but escaping here is what keeps a link URL inside its own attribute: the
// sanitizer drops dangerous attributes, and cannot tell an injected harmless-
// looking one (a style, a second href) from one the author wrote.

// Quotes are escaped as well as &<>: the same function escapes text that lands
// inside href="…", where an unescaped `"` ends the attribute.
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c)

function inline(s: string): string {
  // protect inline code with a collision-proof sentinel before escaping/restoring
  const codes: string[] = []
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => `@@C${codes.push(c) - 1}C@@`)
  s = esc(s)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
    const safe = /^(https?:|\/|#)/.test(url.trim()) ? url : "#"
    return `<a href="${safe}" target="_blank" rel="noreferrer">${text}</a>`
  })
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
  s = s.replace(/@@C(\d+)C@@/g, (_m, i: string) => `<code>${esc(codes[Number(i)] ?? "")}</code>`)
  return s
}

function renderBlock(raw: string): string {
  const lines = raw.split("\n")
  if (/^```/.test(lines[0])) {
    const end = lines[lines.length - 1].startsWith("```") ? -1 : undefined
    return `<pre><code>${esc(lines.slice(1, end).join("\n"))}</code></pre>`
  }
  const h = raw.match(/^(#{1,6})\s+(.*)$/)
  if (h) {
    return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`
  }
  if (/^([-*_])\1{2,}$/.test(raw.trim())) {
    return "<hr>"
  }
  if (lines.length >= 2 && /\|/.test(lines[0]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1])) {
    const cells = (l: string) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim())
    let t = `<table><thead><tr>${cells(lines[0]).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>`
    for (const r of lines.slice(2).map(cells)) {
      t += `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`
    }
    return `${t}</tbody></table>`
  }
  if (lines.every((l) => /^\s*>/.test(l))) {
    return `<blockquote>${inline(lines.map((l) => l.replace(/^\s*>\s?/, "")).join(" "))}</blockquote>`
  }
  if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
    return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`
  }
  if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
    return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ""))}</li>`).join("")}</ol>`
  }
  return `<p>${lines.map(inline).join("<br>")}</p>`
}

export function renderMarkdown(md: string): string {
  const lines = md.split("\n")
  const blocks: string[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i++
      continue
    }
    const buf: string[] = []
    if (/^```/.test(lines[i])) {
      buf.push(lines[i++])
      while (i < lines.length) {
        buf.push(lines[i])
        if (/^```/.test(lines[i++])) {
          break
        }
      }
    } else if (/^#{1,6}\s/.test(lines[i])) {
      buf.push(lines[i++])
    } else if (lines[i + 1] !== undefined && /\|/.test(lines[i]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      while (i < lines.length && /\|/.test(lines[i])) {
        buf.push(lines[i++])
      }
    } else {
      while (i < lines.length && lines[i].trim() !== "" && !/^#{1,6}\s/.test(lines[i]) && !/^```/.test(lines[i])) {
        buf.push(lines[i++])
      }
    }
    blocks.push(renderBlock(buf.join("\n")))
  }
  return blocks.join("\n")
}
