import type {
  CopyBlock,
  Feature,
  Plan,
  ReviewConfigResponse,
  ReviewPostResponse,
  ReviewRequest,
  Step,
} from "../contract.ts"
import {
  AGENT_ID_PATTERN,
  MAX_COMMENT_CHARS,
  MAX_META_TEXT_CHARS,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES,
  MAX_TOTAL_POINTS,
} from "../limits.ts"
import {
  annotateFrame,
  PIN_COLOR,
  PIN_LABEL_FAMILY,
  PIN_LABEL_PX,
  PIN_RADIUS,
  pinPath,
  STROKE_HALO,
  STROKE_HALO_WIDTH,
  STROKE_WIDTH,
  strokePath,
} from "./annotate.ts"
import {
  type CaptureMode,
  DisplayMediaCapture,
  type GrabbedFrame,
  grabCustom,
  SENTINEL_COLOR,
  SENTINEL_PX,
  settle,
} from "./capture.ts"
import { h, svg } from "./dom.ts"
import { icon } from "./icons.ts"
import { meshMark } from "./mark.ts"
import { renderMarkdown, safeHref } from "./markdown.ts"
import { KEY_PREFIX, readJson, writeJson } from "./storage.ts"
import { STYLES } from "./styles.ts"

export type OverlayOptions = {
  server: string
  capture: CaptureMode
  startOpen: boolean
}

type UiState = { open: boolean; feature: number }
type PinState = { n: number; pageX: number; pageY: number; scrollX: number; scrollY: number }
type PagePoint = { pageX: number; pageY: number }
type Status = { kind: "info" | "error" | "success"; text: string }
type SentEntry = { n: number | null; text: string; ok: boolean; detail: string }

const UI_KEY = `${KEY_PREFIX}ui`
const TARGET_KEY = `${KEY_PREFIX}target`
const PIN_SEQ_KEY = `${KEY_PREFIX}pin-seq`
const MIN_STROKE_STEP_PX = 3
// The composer keeps this far from its anchor and from the viewport edges.
const COMPOSER_GAP_PX = 12

const isUiState = (value: unknown): value is UiState =>
  typeof value === "object" &&
  value != null &&
  typeof (value as UiState).open === "boolean" &&
  Number.isInteger((value as UiState).feature)
const isString = (value: unknown): value is string => typeof value === "string"
const isPositiveInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const stepText = (step: Step): string => (typeof step === "string" ? step : step.text)
const stepCopy = (step: Step): CopyBlock[] => (typeof step === "string" ? [] : (step.copy ?? []))
const round1 = (value: number): number => Math.round(value * 10) / 10
const clamp = (args: { value: number; min: number; max: number }): number =>
  Math.min(Math.max(args.value, args.min), args.max)

// One shape for both plan forms: `features`, or a flat `steps` list.
function planFeatures(plan: Plan | null): Feature[] {
  if (plan == null) {
    return []
  }
  if (plan.features != null && plan.features.length > 0) {
    return plan.features
  }
  if (plan.steps != null && plan.steps.length > 0) {
    return [{ title: plan.title ?? "Test plan", steps: plan.steps }]
  }
  return []
}

// Check-off state is keyed by step text, so reordering steps keeps their state
// and rewording a step clears it.
function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function limitStrokes(args: {
  strokes: Array<Array<{ x: number; y: number }>>
  viewport: { w: number; h: number }
}): Array<{ points: Array<{ xPct: number; yPct: number }> }> {
  const strokes = args.strokes.slice(-MAX_STROKES)
  const total = strokes.reduce((sum, stroke) => sum + stroke.length, 0)
  const every = Math.max(1, Math.ceil(total / MAX_TOTAL_POINTS))
  return strokes.map((stroke) => ({
    points: stroke
      .filter((_, index) => index % every === 0 || index === stroke.length - 1)
      .slice(0, MAX_POINTS_PER_STROKE)
      .map((point) => ({
        xPct: round1(clamp({ value: (point.x / args.viewport.w) * 100, min: 0, max: 100 })),
        yPct: round1(clamp({ value: (point.y / args.viewport.h) * 100, min: 0, max: 100 })),
      })),
  }))
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.style.cssText = "position:fixed;top:-1000px;opacity:0"
    document.body.append(area)
    area.select()
    let copied = false
    try {
      copied = document.execCommand("copy")
    } catch {
      copied = false
    }
    area.remove()
    return copied
  }
}

export function createOverlay(options: OverlayOptions): { destroy: () => void } {
  const server = options.server.replace(/\/+$/, "")
  const ui = readJson({ area: "session", key: UI_KEY, fallback: { open: options.startOpen, feature: 0 }, isValid: isUiState })
  const state = {
    open: ui.open,
    featureIndex: ui.feature,
    config: null as ReviewConfigResponse | null,
    loadError: null as string | null,
    commentMode: false,
    tool: "pin" as "pin" | "draw",
    pin: null as PinState | null,
    strokes: [] as PagePoint[][],
    drawing: false,
    sending: false,
    status: null as Status | null,
    captureNote: null as string | null,
    sent: [] as SentEntry[],
    pinSeq: readJson({ area: "local", key: PIN_SEQ_KEY, fallback: 1, isValid: isPositiveInt }),
    target: readJson<string | null>({
      area: "local",
      key: TARGET_KEY,
      fallback: null,
      isValid: (value): value is string | null => isString(value) && value !== "",
    }),
  }
  const capture = new DisplayMediaCapture()

  // A custom element name keeps page rules such as `div { ... }` off the host,
  // and the inline !important values beat page stylesheets.
  const host = document.createElement("reviewer-overlay")
  host.setAttribute("data-reviewer-overlay", "")
  const hostStyle =
    "all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;display:block!important"
  host.style.cssText = hostStyle
  const shadow = host.attachShadow({ mode: "open" })
  const root = h("div", { className: "root" }, [])
  const style = document.createElement("style")
  style.textContent = STYLES
  shadow.append(style, root)

  const sentinel = h("div", { className: "sentinel" }, [])
  sentinel.style.cssText = `position:fixed;left:0;top:0;width:${SENTINEL_PX}px;height:${SENTINEL_PX}px;background:${SENTINEL_COLOR};visibility:visible;z-index:5;display:none;pointer-events:none`
  // The custom capture path renders the DOM itself, so it gets no sentinel.
  const hideHost = () => host.style.setProperty("visibility", "hidden", "important")
  const showHost = () => host.style.setProperty("visibility", "visible", "important")
  const hideForStream = () => {
    sentinel.style.display = "block"
    hideHost()
  }
  const showAfterStream = () => {
    sentinel.style.display = "none"
    showHost()
  }

  // ---- elements ----

  const bubble = h(
    "button",
    { className: "bubble", attrs: { type: "button", "aria-label": "Open reviewer" }, on: { click: () => setOpen(true) } },
    [meshMark({ suffix: "bubble", className: "bubble-mark" }), h("span", { className: "sr-only" }, ["Reviewer"])],
  )

  const targetInput = h(
    "input",
    {
      attrs: { id: "ro-target", type: "text", spellcheck: "false", autocomplete: "off" },
      on: {
        input: () => {
          const value = targetInput.value.trim()
          state.target = value === "" ? null : value
          writeJson({ area: "local", key: TARGET_KEY, value: state.target })
        },
      },
    },
    [],
  )
  const targetRow = h("div", { className: "target" }, [
    h("label", { attrs: { for: "ro-target" } }, ["Send to"]),
    targetInput,
  ])
  const panelBody = h("div", { className: "panel-body" }, [])
  const commentButton = h(
    "button",
    { className: "btn primary", attrs: { type: "button" }, on: { click: () => toggleCommentMode() } },
    ["Add comment"],
  )
  const panelStatus = h("div", { className: "status", attrs: { role: "status" } }, [])
  const panel = h("section", { className: "panel", attrs: { "aria-label": "Reviewer" } }, [
    h("div", { className: "panel-head" }, [
      h("span", { className: "panel-mark" }, [meshMark({ suffix: "panel", className: "mark" })]),
      h("div", { className: "panel-title" }, ["Reviewer"]),
      h(
        "button",
        {
          className: "icon-btn",
          attrs: { type: "button", title: "Reload test plan", "aria-label": "Reload test plan" },
          on: { click: () => void loadConfig() },
        },
        [icon("reload")],
      ),
      h(
        "button",
        {
          className: "icon-btn",
          attrs: { type: "button", title: "Close", "aria-label": "Close reviewer" },
          on: { click: () => setOpen(false) },
        },
        [icon("close")],
      ),
    ]),
    h("div", { className: "panel-tabs" }, [h("div", { className: "panel-tab" }, [icon("plan"), "Test plan"])]),
    panelBody,
    h("div", { className: "panel-foot" }, [targetRow, commentButton, panelStatus]),
  ])

  const layer = h("div", { className: "layer" }, [])
  const marks = svg("svg", { class: "marks", "aria-hidden": "true" })
  const toolButton = (tool: "pin" | "draw", label: string, glyph: "pin" | "pen") =>
    h(
      "button",
      {
        className: "btn",
        attrs: { type: "button", "aria-pressed": "false" },
        on: {
          click: () => {
            state.tool = tool
            render()
          },
        },
      },
      [icon(glyph), label],
    )
  const pinToolButton = toolButton("pin", "Pin", "pin")
  const drawToolButton = toolButton("draw", "Draw", "pen")
  const hint = h("span", { className: "hint" }, [])
  const toolbarStatus = h("div", { className: "status", attrs: { role: "status" } }, [])
  const toolbar = h("div", { className: "toolbar", attrs: { role: "toolbar", "aria-label": "Comment tools" } }, [
    pinToolButton,
    drawToolButton,
    hint,
    h("span", { className: "keys" }, [h("kbd", null, ["Esc"]), "to exit"]),
    h("span", { className: "sep", attrs: { "aria-hidden": "true" } }, []),
    h(
      "button",
      {
        className: "btn",
        attrs: { type: "button" },
        on: {
          click: () => {
            clearAnnotation()
            render()
          },
        },
      },
      ["Clear"],
    ),
    h("button", { className: "btn", attrs: { type: "button" }, on: { click: () => exitCommentMode() } }, ["Done"]),
    toolbarStatus,
  ])

  const composerBadge = h("span", { className: "composer-badge", attrs: { "aria-hidden": "true" } }, [])
  const composerTitle = h("span", { className: "composer-title" }, [])
  const textarea = h(
    "textarea",
    {
      attrs: { placeholder: "What should change here?", maxlength: String(MAX_COMMENT_CHARS), "aria-label": "Comment" },
      on: {
        keydown: (event) => {
          const key = event as KeyboardEvent
          if (key.key === "Enter" && (key.metaKey || key.ctrlKey)) {
            key.preventDefault()
            void send()
          }
        },
      },
    },
    [],
  )
  const sendButton = h(
    "button",
    { className: "btn primary", attrs: { type: "button" }, on: { click: () => void send() } },
    ["Send"],
  )
  const composerStatus = h("div", { className: "status", attrs: { role: "status" } }, [])
  const composer = h("div", { className: "composer", attrs: { role: "dialog", "aria-label": "Comment" } }, [
    h("div", { className: "composer-head" }, [composerBadge, composerTitle]),
    textarea,
    composerStatus,
    h("div", { className: "composer-actions" }, [
      h(
        "button",
        {
          className: "btn",
          attrs: { type: "button" },
          on: {
            click: () => {
              clearAnnotation()
              render()
            },
          },
        },
        ["Cancel"],
      ),
      sendButton,
    ]),
  ])

  root.append(layer, marks, toolbar, composer, bubble, panel, sentinel)

  // ---- state changes ----

  const persistUi = () => writeJson({ area: "session", key: UI_KEY, value: { open: state.open, feature: state.featureIndex } })

  function setOpen(open: boolean) {
    state.open = open
    persistUi()
    if (open) {
      void loadConfig()
    }
    render()
  }

  function setStatus(status: Status | null) {
    state.status = status
    renderStatus()
  }

  const hasAnnotation = () => state.pin != null || state.strokes.length > 0

  function clearAnnotation() {
    state.pin = null
    state.strokes = []
    state.drawing = false
    textarea.value = ""
  }

  function toggleCommentMode() {
    if (state.commentMode) {
      exitCommentMode()
      return
    }
    state.commentMode = true
    state.captureNote = null
    setStatus(null)
    render()
    if (options.capture === "display-media") {
      void capture.start().then((started) => {
        if (!started.ok) {
          state.captureNote = `Screen capture is off (${started.reason}). Notes send without a screenshot.`
          render()
        }
      })
    }
  }

  function exitCommentMode() {
    state.commentMode = false
    capture.stop()
    clearAnnotation()
    render()
  }

  async function loadConfig() {
    try {
      const response = await fetch(`${server}/api/review`, { credentials: "omit", mode: "cors", cache: "no-store" })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      state.config = (await response.json()) as ReviewConfigResponse
      state.loadError = null
      if (state.target == null || targetInput.value === "") {
        targetInput.value = state.target ?? state.config.targetAgentId
      }
    } catch (error) {
      state.loadError = `Cannot reach the review server at ${server} (${error instanceof Error ? error.message : String(error)}). Start it, then reload.`
    }
    render()
  }

  // ---- capture + send ----

  async function grabFrame(): Promise<GrabbedFrame | null> {
    if (options.capture === "none") {
      return null
    }
    if (options.capture === "display-media") {
      if (!capture.isLive()) {
        const started = await capture.startWithTimeout()
        if (!started.ok) {
          state.captureNote = `Screen capture is off (${started.reason}). Notes send without a screenshot.`
          return null
        }
      }
      return capture.grab({ hide: hideForStream, show: showAfterStream })
    }
    return grabCustom({ capture: options.capture, hide: hideHost, show: showHost })
  }

  async function send() {
    if (state.sending) {
      return
    }
    const text = textarea.value.trim()
    const pin = state.pin
    const strokes = state.strokes.filter((stroke) => stroke.length > 0)
    if (text === "" && pin == null && strokes.length === 0) {
      setStatus({ kind: "error", text: "Drop a pin, draw, or write a note first." })
      return
    }
    const canChoose = state.config?.canChooseTarget === true
    const target = canChoose ? state.target : null
    if (target != null && !AGENT_ID_PATTERN.test(target)) {
      setStatus({ kind: "error", text: "The agent id may only contain letters, digits, '.', '_' and '-'." })
      return
    }

    state.sending = true
    setStatus({ kind: "info", text: "Capturing screenshot…" })
    render()
    try {
      // The pin's percentages describe the viewport it was dropped in, so the
      // screenshot is taken from that same scroll position.
      if (pin != null && (window.scrollX !== pin.scrollX || window.scrollY !== pin.scrollY)) {
        window.scrollTo(pin.scrollX, pin.scrollY)
        await settle()
      }
      const viewport = { w: window.innerWidth, h: window.innerHeight }
      const grabbed = await grabFrame()
      const clientPin = pin == null ? null : { x: pin.pageX - window.scrollX, y: pin.pageY - window.scrollY, n: pin.n }
      const clientStrokes = strokes.map((stroke) =>
        stroke.map((point) => ({ x: point.pageX - window.scrollX, y: point.pageY - window.scrollY })),
      )
      let screenshotDataUrl: string | null = null
      let warning = ""
      if (grabbed != null) {
        const frame = grabbed.canvas
        const frameAspect = frame.width / frame.height
        const viewAspect = viewport.w / viewport.h
        if (Math.abs(frameAspect - viewAspect) / viewAspect > 0.03) {
          warning = " The captured frame does not match the viewport, so the pin may be offset. Share this tab, not a window."
        } else if (!grabbed.fresh) {
          warning = " The screen share lagged, so the screenshot may show the overlay."
        }
        screenshotDataUrl = annotateFrame({ frame, viewport, pin: clientPin, strokes: clientStrokes })
      }

      const request: ReviewRequest = {
        comment: text,
        url: location.href,
        pin:
          pin == null || clientPin == null
            ? null
            : {
                n: pin.n,
                xPct: round1((clientPin.x / viewport.w) * 100),
                yPct: round1((clientPin.y / viewport.h) * 100),
                pageX: Math.round(pin.pageX),
                pageY: Math.round(pin.pageY),
              },
        meta: {
          title: document.title.slice(0, MAX_META_TEXT_CHARS),
          viewport: { w: viewport.w, h: viewport.h, dpr: window.devicePixelRatio },
          userAgent: navigator.userAgent.slice(0, MAX_META_TEXT_CHARS),
        },
        screenshotDataUrl,
        capturedAt: new Date().toISOString(),
        targetAgentId: target,
        strokes:
          screenshotDataUrl == null && clientStrokes.length > 0 ? limitStrokes({ strokes: clientStrokes, viewport }) : null,
      }

      setStatus({ kind: "info", text: "Sending…" })
      const response = await fetch(`${server}/api/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        credentials: "omit",
        mode: "cors",
      })
      let data: ReviewPostResponse | null = null
      try {
        data = (await response.json()) as ReviewPostResponse
      } catch {
        data = null
      }
      if (data == null) {
        setStatus({ kind: "error", text: `The review server answered ${response.status} without JSON.` })
        return
      }
      if (!data.ok) {
        const saved = data.reportPath != null ? ` Saved locally at ${data.reportPath}.` : ""
        setStatus({ kind: "error", text: `Not delivered: ${data.message}${saved}` })
        state.sent.unshift({ n: pin?.n ?? null, text, ok: false, detail: data.error })
        return
      }
      const shot = screenshotDataUrl == null ? "without a screenshot" : "with a screenshot"
      setStatus({
        kind: "success",
        text: `Sent to ${data.targetAgentId} ${shot} (message ${data.meshMessageId}).${warning}`,
      })
      state.sent.unshift({ n: pin?.n ?? null, text, ok: true, detail: data.meshMessageId })
      if (pin != null) {
        state.pinSeq = pin.n + 1
        writeJson({ area: "local", key: PIN_SEQ_KEY, value: state.pinSeq })
      }
      clearAnnotation()
    } catch (error) {
      setStatus({
        kind: "error",
        text: `Cannot reach the review server at ${server} (${error instanceof Error ? error.message : String(error)}).`,
      })
    } finally {
      state.sending = false
      render()
    }
  }

  // ---- pointer input on the comment layer ----

  const pagePoint = (event: PointerEvent | MouseEvent): PagePoint => ({
    pageX: event.clientX + window.scrollX,
    pageY: event.clientY + window.scrollY,
  })

  layer.addEventListener("click", (event) => {
    if (state.tool !== "pin" || state.sending) {
      return
    }
    const point = pagePoint(event)
    state.pin = {
      n: state.pin?.n ?? state.pinSeq,
      pageX: point.pageX,
      pageY: point.pageY,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    }
    setStatus(null)
    render()
    textarea.focus()
  })
  layer.addEventListener("pointerdown", (event) => {
    if (state.tool !== "draw" || state.sending) {
      return
    }
    event.preventDefault()
    layer.setPointerCapture(event.pointerId)
    state.drawing = true
    state.strokes.push([pagePoint(event)])
    renderMarks()
  })
  layer.addEventListener("pointermove", (event) => {
    const stroke = state.strokes[state.strokes.length - 1]
    if (!state.drawing || stroke == null) {
      return
    }
    const point = pagePoint(event)
    const last = stroke[stroke.length - 1]
    if (last != null && Math.hypot(point.pageX - last.pageX, point.pageY - last.pageY) < MIN_STROKE_STEP_PX) {
      return
    }
    stroke.push(point)
    renderMarks()
  })
  const endStroke = (event: PointerEvent) => {
    if (!state.drawing) {
      return
    }
    state.drawing = false
    try {
      layer.releasePointerCapture(event.pointerId)
    } catch {
      // Already released.
    }
    setStatus(null)
    render()
  }
  layer.addEventListener("pointerup", endStroke)
  layer.addEventListener("pointercancel", endStroke)

  // Keys typed in the overlay stay in the overlay, so page shortcuts do not
  // fire while the reviewer writes a note.
  for (const type of ["keydown", "keyup", "keypress"]) {
    root.addEventListener(type, (event) => event.stopPropagation())
  }
  const onWindowKey = (event: KeyboardEvent) => {
    if (!state.commentMode || event.key !== "Escape") {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (hasAnnotation()) {
      clearAnnotation()
      render()
      return
    }
    exitCommentMode()
  }
  const onViewportChange = () => {
    if (state.commentMode) {
      renderMarks()
      positionComposer()
    }
  }
  window.addEventListener("keydown", onWindowKey, true)
  window.addEventListener("scroll", onViewportChange, { passive: true })
  window.addEventListener("resize", onViewportChange)

  // ---- rendering ----

  function renderMarks() {
    const children: SVGElement[] = []
    const sx = window.scrollX
    const sy = window.scrollY
    for (const stroke of state.strokes) {
      const points = stroke.map((point) => ({ x: point.pageX - sx, y: point.pageY - sy }))
      const first = points[0]
      if (first == null) {
        continue
      }
      const d = points.length === 1 ? `M ${first.x} ${first.y} l 0.01 0` : strokePath(points)
      const common = { d, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" }
      children.push(svg("path", { ...common, stroke: STROKE_HALO, "stroke-width": String(STROKE_HALO_WIDTH) }))
      children.push(svg("path", { ...common, stroke: PIN_COLOR, "stroke-width": String(STROKE_WIDTH) }))
    }
    if (state.pin != null) {
      const { d, cx, cy } = pinPath({ x: state.pin.pageX - sx, y: state.pin.pageY - sy, r: PIN_RADIUS })
      children.push(svg("path", { d, class: "pin", fill: PIN_COLOR, stroke: "#ffffff", "stroke-width": "2" }))
      const label = svg("text", {
        x: String(cx),
        y: String(cy + 0.5),
        fill: "#ffffff",
        "font-size": String(PIN_LABEL_PX),
        "font-weight": "700",
        "font-family": PIN_LABEL_FAMILY,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
      })
      label.textContent = String(state.pin.n)
      children.push(label)
    }
    marks.replaceChildren(...children)
  }

  function positionComposer() {
    if (composer.hidden) {
      return
    }
    let anchor: { x: number; y: number } | null = null
    if (state.pin != null) {
      anchor = { x: state.pin.pageX - window.scrollX, y: state.pin.pageY - window.scrollY }
    } else {
      const lastStroke = state.strokes[state.strokes.length - 1]
      const lastPoint = lastStroke?.[lastStroke.length - 1]
      if (lastPoint != null) {
        anchor = { x: lastPoint.pageX - window.scrollX, y: lastPoint.pageY - window.scrollY }
      }
    }
    if (anchor == null) {
      return
    }
    const width = composer.offsetWidth || 320
    const height = composer.offsetHeight || 180
    // The open panel docks on the right, so the composer fits in the space left
    // of it, and flips to the anchor's left side when the right side is short.
    const panelLeft = state.open ? panel.getBoundingClientRect().left : window.innerWidth
    const right = panelLeft - width - COMPOSER_GAP_PX >= COMPOSER_GAP_PX ? panelLeft : window.innerWidth
    const beside = anchor.x + 18 + width + COMPOSER_GAP_PX <= right ? anchor.x + 18 : anchor.x - 18 - width
    const left = clamp({ value: beside, min: COMPOSER_GAP_PX, max: right - width - COMPOSER_GAP_PX })
    const top = clamp({ value: anchor.y + COMPOSER_GAP_PX, min: COMPOSER_GAP_PX, max: window.innerHeight - height - COMPOSER_GAP_PX })
    composer.style.left = `${left}px`
    composer.style.top = `${top}px`
  }

  function renderStatus() {
    const composerVisible = !composer.hidden
    const targets: Array<[HTMLElement, boolean]> = [
      [composerStatus, composerVisible],
      [toolbarStatus, state.commentMode && !composerVisible],
      [panelStatus, !state.commentMode],
    ]
    for (const [element, visible] of targets) {
      const status = visible ? state.status : null
      element.hidden = status == null
      element.textContent = status?.text ?? ""
      element.className = `status${status == null || status.kind === "info" ? "" : ` ${status.kind}`}`
    }
  }

  function errorBox(text: string): HTMLElement {
    return h("div", { className: "error-box", attrs: { role: "alert" } }, [text])
  }

  function renderFeature(args: { plan: Plan; feature: Feature; index: number }): HTMLElement {
    const { plan, feature, index } = args
    const checksKey = `${KEY_PREFIX}checks:${plan.title ?? "untitled"}`
    const checked = new Set(readJson({ area: "local", key: checksKey, fallback: [] as string[], isValid: isStringArray }))
    const featureKey = feature.id ?? `#${index}`
    const steps = feature.steps ?? []
    const stepKeys = steps.map((step) => `${featureKey}:${hashText(stepText(step))}`)
    const doneCount = stepKeys.filter((key) => checked.has(key)).length

    const meta = [feature.badge, feature.ticket, feature.tag].filter((value): value is string => value != null && value !== "")
    let link: HTMLElement | null = null
    if (feature.url != null) {
      const href = safeHref({ href: feature.url, base: location.href })
      if (href != null && !href.startsWith("mailto:")) {
        const sameOrigin = new URL(href).origin === location.origin
        link = h(
          "a",
          {
            className: "link small",
            attrs: { href, ...(sameOrigin ? {} : { target: "_blank", rel: "noopener noreferrer" }) },
          },
          [`Open ${feature.url} ↗`],
        )
      }
    }

    const stepList = h(
      "ul",
      { className: "steps" },
      steps.map((step, stepIndex) => {
        const key = stepKeys[stepIndex] ?? `${featureKey}:${stepIndex}`
        const isDone = checked.has(key)
        const box = h("input", { attrs: { type: "checkbox", "aria-label": `Step ${stepIndex + 1} done` } }, [])
        box.checked = isDone
        box.addEventListener("change", () => {
          if (box.checked) {
            checked.add(key)
          } else {
            checked.delete(key)
          }
          writeJson({ area: "local", key: checksKey, value: [...checked] })
          renderPanelBody()
        })
        const text = h("div", { className: "step-text" }, [renderMarkdown(stepText(step))])
        const copies = stepCopy(step).map((block) => {
          const button = h("button", { className: "btn small", attrs: { type: "button" } }, ["Copy"])
          button.addEventListener("click", () => {
            void copyText(block.text).then((ok) => {
              button.textContent = ok ? "Copied" : "Copy failed"
              window.setTimeout(() => {
                button.textContent = "Copy"
              }, 1200)
            })
          })
          return h("div", { className: "copy" }, [
            h("div", { className: "copy-head" }, [
              h("span", { className: "small muted" }, [block.label ?? block.kind ?? "copy"]),
              button,
            ]),
            h("pre", null, [block.text]),
          ])
        })
        return h("li", { className: `step${isDone ? " done" : ""}` }, [
          box,
          h("div", { className: "step-body" }, [text, ...copies]),
        ])
      }),
    )

    return h("div", { className: "feature" }, [
      meta.length > 0
        ? h(
            "div",
            { className: "feature-meta" },
            meta.map((value, metaIndex) =>
              h("span", { className: metaIndex === 0 && feature.badge != null ? "badge" : "small muted" }, [value]),
            ),
          )
        : null,
      feature.title != null ? h("div", { className: "feature-title" }, [feature.title]) : null,
      link,
      feature.intro != null ? renderMarkdown(feature.intro) : null,
      steps.length > 0 ? stepList : null,
      feature.pass != null ? h("div", { className: "pass" }, [h("strong", null, ["Pass: "]), feature.pass]) : null,
      feature.note != null ? h("div", { className: "note small" }, [renderMarkdown(feature.note)]) : null,
      steps.length > 0 ? h("div", { className: "small muted" }, [`${doneCount} of ${steps.length} steps checked`]) : null,
    ])
  }

  function renderPlan(): Array<HTMLElement> {
    if (state.loadError != null) {
      return [errorBox(state.loadError)]
    }
    const config = state.config
    if (config == null) {
      return [h("div", { className: "muted" }, ["Loading…"])]
    }
    if (config.planError != null) {
      return [errorBox(config.planError)]
    }
    const plan = config.plan
    const features = planFeatures(plan)
    if (plan == null || features.length === 0) {
      return [h("div", { className: "muted" }, ["No test plan loaded. You can still add comments."])]
    }
    const index = clamp({ value: state.featureIndex, min: 0, max: features.length - 1 })
    const feature = features[index]
    const nodes: HTMLElement[] = []
    const title = plan.title != null ? h("div", { className: "plan-title" }, [plan.title]) : null
    let nav: HTMLElement | null = null
    if (features.length > 1) {
      const go = (next: number) => () => {
        state.featureIndex = next
        persistUi()
        renderPanelBody()
      }
      const previous = h(
        "button",
        { className: "btn", attrs: { type: "button", "aria-label": "Previous feature" }, on: { click: go(index - 1) } },
        ["‹"],
      )
      const next = h(
        "button",
        { className: "btn", attrs: { type: "button", "aria-label": "Next feature" }, on: { click: go(index + 1) } },
        ["›"],
      )
      previous.disabled = index === 0
      next.disabled = index === features.length - 1
      nav = h("div", { className: "feature-nav" }, [
        previous,
        h("span", { className: "small muted" }, [`Feature ${index + 1} of ${features.length}`]),
        next,
      ])
    }
    if (title != null || nav != null) {
      nodes.push(h("div", { className: "plan-head" }, [title ?? h("div", null, []), nav]))
    }
    if (plan.subtitle != null) {
      nodes.push(h("div", { className: "muted small" }, [renderMarkdown(plan.subtitle)]))
    }
    if (feature != null) {
      nodes.push(renderFeature({ plan, feature, index }))
    }
    return nodes
  }

  function renderSent(): HTMLElement | null {
    if (state.sent.length === 0) {
      return null
    }
    return h("div", { className: "sent" }, [
      h("div", { className: "small muted" }, ["Sent this session"]),
      ...state.sent.slice(0, 10).map((entry) =>
        h("div", { className: "sent-item" }, [
          h("span", { className: "muted sent-tag" }, [entry.n == null ? "–" : `#${entry.n}`]),
          h("span", { className: "text" }, [entry.text === "" ? "(no text)" : entry.text]),
          h("span", { className: entry.ok ? "status success" : "status error" }, [entry.ok ? "delivered" : "failed"]),
        ]),
      ),
    ])
  }

  function renderPanelBody() {
    const scroll = panelBody.scrollTop
    const sent = renderSent()
    panelBody.replaceChildren(...renderPlan(), ...(sent == null ? [] : [sent]))
    panelBody.scrollTop = scroll
  }

  function render() {
    bubble.hidden = state.open
    panel.hidden = !state.open
    targetRow.hidden = state.config?.canChooseTarget !== true
    commentButton.textContent = state.commentMode ? "Exit comment mode" : "Add comment"

    layer.hidden = !state.commentMode
    marks.style.display = state.commentMode ? "" : "none"
    toolbar.hidden = !state.commentMode
    composer.hidden = !(state.commentMode && hasAnnotation() && !state.drawing)
    layer.className = state.tool === "draw" ? "layer draw" : "layer"
    pinToolButton.className = state.tool === "pin" ? "btn on" : "btn"
    drawToolButton.className = state.tool === "draw" ? "btn on" : "btn"
    pinToolButton.setAttribute("aria-pressed", String(state.tool === "pin"))
    drawToolButton.setAttribute("aria-pressed", String(state.tool === "draw"))
    hint.textContent =
      state.captureNote ?? (state.tool === "pin" ? "Click the page to drop a pin" : "Drag on the page to draw")
    composerTitle.textContent = state.pin != null ? `Pin #${state.pin.n}` : "Drawing"
    composerBadge.className = state.pin != null ? "composer-badge" : "composer-badge pen"
    composerBadge.replaceChildren(state.pin != null ? String(state.pin.n) : icon("pen"))
    sendButton.disabled = state.sending
    sendButton.textContent = state.sending ? "Sending…" : "Send"

    if (state.open) {
      renderPanelBody()
    }
    renderMarks()
    renderStatus()
    positionComposer()
  }

  // ---- mount ----

  const mount = () => {
    if (!host.isConnected) {
      document.body.append(host)
    }
  }
  // Some apps replace the whole <body> content on navigation; put the overlay
  // back when that removes it.
  const observer = new MutationObserver(() => {
    if (!host.isConnected) {
      mount()
    }
  })
  mount()
  observer.observe(document.body, { childList: true })
  render()
  void loadConfig()

  return {
    destroy: () => {
      observer.disconnect()
      capture.stop()
      window.removeEventListener("keydown", onWindowKey, true)
      window.removeEventListener("scroll", onViewportChange)
      window.removeEventListener("resize", onViewportChange)
      host.remove()
    },
  }
}
