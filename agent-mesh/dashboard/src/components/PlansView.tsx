import { MessageSquarePlus } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { api, type PlanDoc } from "@/lib/api"
import { sanitizePlanHtml } from "@/lib/plan-html"
import { usePersistedState } from "@/lib/usePersistedState"
import { Button, Input, Textarea } from "@/components/ui/core"

// anchor = nearest heading at/before the selection, in document order
function anchorFor(root: HTMLElement, node: Node): string {
  let a = "(top)"
  for (const h of Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    if (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
      a = (h.textContent ?? "").trim()
    } else {
      break
    }
  }
  return a
}
function selectedImages(root: HTMLElement, range: Range): HTMLImageElement[] {
  return Array.from(root.querySelectorAll("img")).filter((im) => {
    try {
      return range.intersectsNode(im)
    } catch {
      return false
    }
  })
}

type Pending = { quote: string; anchor: string; range: Range | null; imgs: HTMLImageElement[] }
type XY = { x: number; y: number }

// CSS Custom Highlight API isn't in TS's lib yet — narrow access through any.
const HighlightCtor = (globalThis as { Highlight?: new () => { add: (r: Range) => void; clear: () => void } }).Highlight
const cssHighlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights

export function PlansView({ initialPlan, target }: { initialPlan: string | null; target: string }) {
  const [planPath, setPlanPath] = usePersistedState<string>("plan-path", "")
  const [pathInput, setPathInput] = useState(initialPlan ?? planPath)
  const [doc, setDoc] = useState<PlanDoc | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sent, setSent] = useState(0)
  const [selBtn, setSelBtn] = useState<XY | null>(null)
  const [composer, setComposer] = useState<XY | null>(null)
  const [draft, setDraft] = useState("")
  const [sendErr, setSendErr] = useState<string | null>(null)
  const docRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef<Pending | null>(null)
  const hlRef = useRef<{ add: (r: Range) => void; clear: () => void } | null>(null)

  // URL deep-link wins over the persisted path on arrival.
  useEffect(() => {
    if (initialPlan != null && initialPlan !== "") {
      setPlanPath(initialPlan)
      setPathInput(initialPlan)
    }
  }, [initialPlan, setPlanPath])

  // Fetch the plan whenever the committed path changes.
  useEffect(() => {
    if (planPath.trim() === "") {
      setDoc(null)
      return
    }
    let cancelled = false
    api
      .planRead(planPath)
      .then((d) => {
        if (!cancelled) {
          setDoc(d)
          setErr(null)
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setErr(e.message)
          setDoc(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [planPath])

  // Render the doc into the container (sanitized HTML; markdown via the
  // renderer, then sanitized), rewrite relative <img> srcs to the asset
  // endpoint, and reset the highlight.
  useEffect(() => {
    const el = docRef.current
    if (el == null) {
      return
    }
    if (doc == null) {
      el.innerHTML = ""
      return
    }
    el.innerHTML = sanitizePlanHtml({ format: doc.format, content: doc.content })
    el.className = doc.format === "html" ? "" : "plan-md"
    for (const img of Array.from(el.querySelectorAll("img"))) {
      const raw = img.getAttribute("src") ?? ""
      if (raw !== "" && !/^(https?:|data:|\/)/.test(raw)) {
        img.src = api.planAssetUrl(doc.path, raw)
      }
    }
    if (hlRef.current == null && HighlightCtor != null && cssHighlights != null) {
      hlRef.current = new HighlightCtor()
      cssHighlights.set("plan-comment", hlRef.current)
    } else {
      hlRef.current?.clear()
    }
  }, [doc])

  // Selection inside the doc → floating Comment button (text or image).
  useEffect(() => {
    const onSel = () => {
      const el = docRef.current
      const sel = window.getSelection()
      if (el == null || sel == null || sel.rangeCount === 0) {
        setSelBtn(null)
        return
      }
      const range = sel.getRangeAt(0)
      if (!el.contains(range.commonAncestorContainer)) {
        setSelBtn(null)
        return
      }
      const imgs = selectedImages(el, range)
      if (sel.toString().trim() === "" && imgs.length === 0) {
        setSelBtn(null)
        return
      }
      const r = range.getBoundingClientRect()
      const rr = r.width || r.height ? r : imgs[0]?.getBoundingClientRect() ?? r
      setSelBtn({ x: rr.left + rr.width / 2, y: rr.top - 6 })
    }
    document.addEventListener("selectionchange", onSel)
    return () => document.removeEventListener("selectionchange", onSel)
  }, [])

  const openComposer = useCallback(() => {
    const el = docRef.current
    const sel = window.getSelection()
    if (el == null || sel == null || sel.rangeCount === 0) {
      return
    }
    const range = sel.getRangeAt(0)
    const text = sel.toString().trim()
    const imgs = selectedImages(el, range)
    const quote = text !== "" ? text : `[image] ${imgs.map((i) => i.alt || (i.getAttribute("src") ?? "").split("/").pop()).join(", ")}`
    pendingRef.current = { quote, anchor: anchorFor(el, range.startContainer), range: range.cloneRange(), imgs }
    const r = range.getBoundingClientRect()
    const rr = r.width || r.height ? r : imgs[0]?.getBoundingClientRect() ?? r
    setSelBtn(null)
    setDraft("")
    setSendErr(null)
    setComposer({ x: rr.left, y: rr.bottom + 8 })
  }, [])

  const send = useCallback(async () => {
    const pending = pendingRef.current
    if (pending == null || draft.trim() === "" || doc == null) {
      return
    }
    let res: { id?: string; to?: string; error?: unknown }
    try {
      res = await api.publish({
        from: "operator",
        to: target,
        type: "request",
        body: { plan: doc.name, planPath: doc.path, anchor: pending.anchor, quote: pending.quote.slice(0, 600), comment: draft.trim(), ts: new Date().toISOString() },
        correlationId: "plan-review",
        replyTo: null,
      })
    } catch (e: unknown) {
      setSendErr(e instanceof Error ? e.message : "network error")
      return
    }
    if (res.error != null) {
      setSendErr(typeof res.error === "string" ? res.error : "publish failed")
      return
    }
    setSent((n) => n + 1)
    if (hlRef.current != null && pending.range != null) {
      try {
        hlRef.current.add(pending.range)
      } catch {
        /* range invalidated by a re-render — skip the highlight */
      }
    }
    for (const im of pending.imgs) {
      im.classList.add("commented")
    }
    window.getSelection()?.removeAllRanges()
    setComposer(null)
    setDraft("")
    pendingRef.current = null
  }, [draft, doc, target])

  const commitPath = () => setPlanPath(pathInput.trim())

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/70 px-4 py-2.5">
        <Input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commitPath()}
          placeholder="plans/<file>.md   ·   or an absolute /path/to/plan.html"
          className="max-w-xl font-mono text-xs"
          spellCheck={false}
        />
        <Button variant="secondary" size="sm" onClick={commitPath}>
          Load
        </Button>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          select text or image to comment <span className="text-border">·</span>{" "}
          <span className="text-primary">{sent}</span> sent <span className="text-border">→</span> {target}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {err != null ? (
          <div className="mx-auto mt-10 max-w-2xl rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {err}
          </div>
        ) : doc == null ? (
          <div className="mx-auto mt-10 max-w-2xl px-4 text-sm leading-relaxed text-muted-foreground">
            Enter a plan path and press <span className="font-medium text-foreground">Load</span>. Relative paths
            resolve from the dashboard's plans root (set <code className="font-mono">AGENT_MESH_PLANS_ROOT</code>;
            it defaults to the checkout the dashboard runs from). Absolute paths must be inside that checkout, one of
            its git worktrees, or a directory in <code className="font-mono">AGENT_MESH_PLANS_ROOTS</code>.
          </div>
        ) : (
          <div className="mx-auto max-w-[860px] px-6 pt-3 font-mono text-[11px] text-muted-foreground/70">
            base: {doc.root}
          </div>
        )}
        <div className="mx-auto max-w-[860px] px-6 py-8">
          <div id="plan-doc" ref={docRef} />
        </div>
      </div>

      {selBtn != null ? (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={openComposer}
          style={{ position: "fixed", left: selBtn.x - 46, top: selBtn.y - 32, zIndex: 50 }}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground shadow-lg"
        >
          <MessageSquarePlus className="size-3.5" /> Comment
        </button>
      ) : null}

      {composer != null ? (
        <div
          style={{ position: "fixed", left: Math.min(composer.x, window.innerWidth - 360), top: composer.y, zIndex: 60, width: 340 }}
          className="rounded-lg border border-border bg-popover p-3 shadow-2xl"
        >
          {pendingRef.current != null ? (
            <div className="mb-2 max-h-14 overflow-auto border-l-2 border-primary pl-2 font-mono text-[11px] text-muted-foreground">
              {pendingRef.current.quote.slice(0, 240)}
            </div>
          ) : null}
          <Textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Your comment for the planner…" className="min-h-[68px] font-sans text-sm" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void send()} />
          <div className="mt-2 flex items-center gap-2">
            <span className="flex-1 truncate font-mono text-[11px] text-muted-foreground">↳ {pendingRef.current?.anchor}</span>
            {sendErr != null ? <span className="text-[11px] text-destructive">{sendErr}</span> : null}
            <Button variant="ghost" size="sm" onClick={() => { setComposer(null); pendingRef.current = null }}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => void send()} disabled={draft.trim() === ""}>
              Send to {target}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
