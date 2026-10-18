// The Plans tab renders agent-written plans into the dashboard's own origin.
// These checks run the dashboard's real markdown renderer and its real
// sanitizer configuration (bound to jsdom) against hostile plans.
//
// The sanitizer half needs dompurify (installed with the dashboard: `pnpm --dir
// agent-mesh ui:deps`) and jsdom; without them it reports SKIP instead of
// passing silently.
//
//   tsx src/test/test-plan-render.ts

import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(__dirname, "..", "..")
const DASHBOARD_LIB = join(PACKAGE_DIR, "dashboard", "src", "lib")

type Sanitize = (args: { format: "markdown" | "html"; content: string }) => string

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++
  }
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
}

// Attribute names on every opening tag (or only `<tag>` ones), read the way an
// HTML parser would split them: a value runs to the next raw double quote.
function attributeNames(html: string, tag: string | null): string[][] {
  const opening = tag == null ? /<[a-zA-Z][a-zA-Z0-9]*\s([^>]*)>/g : new RegExp(`<${tag}\\s([^>]*)>`, "g")
  return [...html.matchAll(opening)].map((m) => [...m[1].matchAll(/([a-zA-Z-]+)="[^"]*"/g)].map((a) => a[1].toLowerCase()))
}
const anchorAttributeNames = (html: string) => attributeNames(html, "a")

// The dashboard modules are loaded by computed URL: they sit outside this
// package's tsconfig rootDir, so a literal specifier would pull them into
// `tsc` here.
async function loadDashboardModule<T>(file: string): Promise<T> {
  return (await import(pathToFileURL(join(DASHBOARD_LIB, file)).href)) as T
}

async function runMarkdownChecks(): Promise<void> {
  const { renderMarkdown } = await loadDashboardModule<{ renderMarkdown: (md: string) => string }>("plan-markdown.ts")
  const breakout = renderMarkdown('[x](https://a" onmouseover="alert(1))')
  const names = anchorAttributeNames(breakout)
  check("a quote in a link URL cannot add attributes", names.length === 1 && names[0].every((n) => ["href", "target", "rel"].includes(n)), breakout)
  const single = renderMarkdown("[x](https://a' onmouseover='alert(1))")
  check("single quotes in a link URL are escaped too", !single.includes("'") && anchorAttributeNames(single)[0]?.length === 3, single)
  const js = renderMarkdown("[x](javascript:alert(1))")
  check("a javascript: link becomes #", js.includes('href="#"') && !js.includes("javascript:"), js)
  const raw = renderMarkdown("hello <img src=x onerror=alert(1)> world")
  check("raw HTML in markdown text is escaped", !raw.includes("<img") && raw.includes("&lt;img"), raw)
  const code = renderMarkdown('`<script>alert("x")</script>`')
  check("inline code is escaped", !code.includes("<script>"), code)
  const normal = renderMarkdown("# Title\n\n| a | b |\n|---|---|\n| 1 | **2** |\n\n- [docs](https://example.com/x)")
  check(
    "ordinary markdown still renders",
    normal.includes("<h1>Title</h1>") && normal.includes("<td><strong>2</strong></td>") && normal.includes('href="https://example.com/x"'),
    normal,
  )
}

function loadPurifier(): unknown | null {
  // jsdom resolves from this package (a devDependency of agent-mesh); dompurify
  // from the dashboard, which is the copy the browser bundle uses.
  const dashboardPkg = join(PACKAGE_DIR, "dashboard", "package.json")
  if (!existsSync(dashboardPkg)) return null
  try {
    const { JSDOM } = createRequire(join(PACKAGE_DIR, "package.json"))("jsdom") as { JSDOM: new (html: string) => { window: unknown } }
    const createDOMPurify = createRequire(dashboardPkg)("dompurify") as (window: unknown) => unknown
    return createDOMPurify(new JSDOM("").window)
  } catch {
    return null
  }
}

async function runSanitizerChecks(): Promise<void> {
  const purifier = loadPurifier()
  if (purifier == null) {
    console.log("  [SKIP] plan sanitizer checks — dompurify or jsdom not installed (run `pnpm --dir agent-mesh ui:deps`)")
    return
  }
  const { createPlanSanitizer } = await loadDashboardModule<{ createPlanSanitizer: (p: unknown) => Sanitize }>("plan-sanitizer.ts")
  const sanitize = createPlanSanitizer(purifier)
  const hostile = [
    "<!doctype html><html><head><title>Plan</title><style>.mock{color:red}</style><script>alert(1)</script></head><body>",
    '<h1 class="mock" onclick="steal()">Plan</h1>',
    '<img src="x" onerror="fetch(\'/api/publish\')">',
    '<a href="javascript:alert(1)">js</a>',
    '<a href="https://example.com" target="_blank">ext</a>',
    '<svg><circle r="5" onload="x()"></circle></svg>',
    '<form action="/api/unregister" method="post"><input name="id" value="victim"><button>go</button></form>',
    '<iframe src="/api/plan-read?path=x.md"></iframe>',
    '<div style="display:grid">mockup</div>',
    "</body></html>",
  ].join("")
  const out = sanitize({ format: "html", content: hostile })
  for (const needle of ["<script", "onclick", "onerror", "onload", "javascript:", "<form", "<iframe"]) {
    const kept = out.toLowerCase().includes(needle)
    check(`HTML plan loses ${needle}`, !kept, kept ? out : "")
  }
  check("HTML plan keeps its <head> styles", out.includes("<style>.mock{color:red}</style>"))
  const fragment = sanitize({ format: "html", content: '<style>.pr-doc h1{color:red}</style><div class="pr-doc"><h1>x</h1></div>' })
  check("a fragment plan keeps its leading <style> block", fragment.includes("<style>.pr-doc h1{color:red}</style>") && fragment.includes('<div class="pr-doc">'), fragment)
  check("HTML plan keeps inline styles and form controls", out.includes('style="display:grid"') && out.includes("<input") && out.includes("<button>"))
  const noopener = /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">/.test(out)
  check("new-tab links get noopener", noopener, noopener ? "" : out)
  const md = sanitize({ format: "markdown", content: '# Plan\n\n[x](https://a" onmouseover="alert(1))\n\n<img src=x onerror=alert(1)>' })
  const handlers = attributeNames(md, null).flat().filter((n) => n.startsWith("on"))
  check("markdown plan output carries no event-handler attributes", handlers.length === 0 && md.includes("<h1>Plan</h1>"), handlers.length === 0 ? "" : md)
}

export async function runPlanRenderTest(): Promise<number> {
  console.log(`\n== dashboard plan rendering (markdown escaping, HTML sanitizer) ==`)
  failures = 0
  await runMarkdownChecks()
  await runSanitizerChecks()
  console.log(`\nplan rendering: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}

if (process.argv[1]?.endsWith("test-plan-render.ts")) {
  runPlanRenderTest().then((n) => process.exit(n > 0 ? 1 : 0))
}
