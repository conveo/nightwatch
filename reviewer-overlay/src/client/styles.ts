// Lives inside the shadow root, so these rules cannot reach the host page and
// page rules cannot reach them. Inherited properties are reset on `.root`
// because the shadow tree still inherits font and color from the host element.
//
// The look follows the in-app reviewer: a round launcher with the mesh mark, a
// sidebar docked on the right, a dark pill toolbar, and coral actions. Never use
// text-transform on text the e2e scripts read: innerText returns it transformed.
export const STYLES = `
:host { all: initial; }
.root {
  --bg: #ffffff;
  --fg: #1e1e1e;
  --fg-soft: #343230;
  --muted: #838180;
  --line: #ebe7e2;
  --line-strong: #d9d4cc;
  --soft: #fbfaf9;
  --soft-2: #f4f1ed;
  --accent: #ee634f;
  --accent-from: #f16e66;
  --accent-to: #ea5a3a;
  --accent-fg: #1e1e1e;
  --accent-tint: #fdf2ed;
  --accent-tint-line: #f4e8e1;
  --pin: #e7000b;
  --pin-tint: #f8e1e1;
  --ok: #0f8a3c;
  --ok-tint: #e7f3eb;
  --err: #c8000a;
  --ink: #282725;
  --ink-fg: #f4f1ed;
  --ink-muted: #a8a5a1;
  --ink-line: #3b3936;
  --shadow: 0 12px 40px rgba(40,24,12,.12), 0 2px 8px rgba(40,24,12,.06);
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace;
  font: 13px/1.5 var(--sans);
  color: var(--fg);
  letter-spacing: normal;
  text-align: left;
  text-transform: none;
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .root {
    --bg: #1c1b1a;
    --fg: #f4f1ed;
    --fg-soft: #e2ded8;
    --muted: #a8a5a1;
    --line: #34322f;
    --line-strong: #4a4744;
    --soft: #242321;
    --soft-2: #2d2b29;
    --accent-tint: #3a2620;
    --accent-tint-line: #4d3027;
    --pin-tint: #43191a;
    --ok: #4ade80;
    --ok-tint: #173323;
    --err: #ff7b72;
    --ink: #2d2b29;
    --ink-line: #4a4744;
    --shadow: 0 12px 40px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.3);
  }
}
.root *, .root *::before, .root *::after { box-sizing: border-box; }
button, input, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
.icon { width: 14px; height: 14px; flex: none; display: block; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid var(--line); background: var(--soft); color: var(--fg-soft); border-radius: 8px;
  padding: 6px 12px; line-height: 1.2; font-weight: 500;
}
.btn:hover { background: var(--soft-2); }
.btn:disabled { opacity: .5; cursor: default; }
.btn:focus-visible, .icon-btn:focus-visible, .bubble:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn.primary {
  background: linear-gradient(90deg, var(--accent-from), var(--accent-to)); border-color: transparent;
  color: var(--accent-fg); font-weight: 500; box-shadow: 0 4px 12px rgba(234,90,58,.28);
}
.btn.primary:hover { filter: brightness(1.04); }
.btn.on { background: var(--fg); border-color: var(--fg); color: var(--bg); }
.btn.small { padding: 3px 8px; font-size: 11px; border-radius: 6px; }
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; background: transparent; padding: 6px; border-radius: 6px; color: var(--muted); line-height: 1;
}
.icon-btn:hover { background: var(--soft-2); color: var(--fg); }

.bubble {
  position: fixed; right: 24px; bottom: 24px; z-index: 4;
  display: flex; align-items: center; justify-content: center;
  width: 54px; height: 54px; padding: 0; border-radius: 50%;
  border: 1px solid var(--accent-tint-line); background: var(--accent-tint);
  box-shadow: var(--shadow);
  transition: transform .15s ease, box-shadow .15s ease;
}
.bubble:hover { transform: translateY(-1px); box-shadow: 0 16px 44px rgba(40,24,12,.16), 0 2px 8px rgba(40,24,12,.08); }
.bubble-mark { width: 30px; height: 30px; display: block; }

.panel {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 4;
  width: min(360px, 100vw);
  display: flex; flex-direction: column;
  background: var(--bg); border-left: 1px solid var(--line);
  box-shadow: -12px 0 40px rgba(40,24,12,.06); overflow: hidden;
}
.panel::before {
  content: ""; position: absolute; top: 0; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent) 55%, transparent);
}
.panel-head { display: flex; align-items: center; gap: 8px; padding: 14px 12px 14px 16px; border-bottom: 1px solid var(--line); }
.panel-mark {
  width: 28px; height: 28px; flex: none; border-radius: 50%; background: var(--accent-tint);
  display: flex; align-items: center; justify-content: center;
}
.panel-mark .mark { width: 22px; height: 22px; display: block; }
.panel-title { font: 700 13px/1.2 var(--mono); flex: 1; color: var(--fg); }
.panel-tabs { display: flex; gap: 20px; padding: 0 16px; border-bottom: 1px solid var(--line); }
.panel-tab {
  display: flex; align-items: center; gap: 6px; padding: 12px 0 11px; margin-bottom: -1px;
  font: 500 10.5px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--fg-soft);
  border-bottom: 2px solid var(--accent);
}
.panel-tab .icon { width: 12px; height: 12px; }
.panel-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-wrap: anywhere; }
.panel-foot { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px 16px; border-top: 1px solid var(--line); }
.panel-foot .btn { width: 100%; padding: 9px 12px; }
.target { display: flex; flex-direction: column; gap: 6px; }
.target label { color: var(--fg-soft); font-size: 12px; }
.target input {
  width: 100%; min-width: 0; border: 1px solid var(--line-strong); border-radius: 8px; padding: 7px 10px;
  background: var(--bg); font: 12px/1.3 var(--mono); color: var(--fg);
}
.target input:focus { outline: none; border-color: var(--fg); }

.plan-title { flex: 1 1 auto; min-width: 0; font-weight: 600; font-size: 16px; line-height: 1.3; color: var(--fg); }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.plan-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.feature-nav { display: flex; align-items: center; justify-content: flex-end; gap: 2px; flex: none; }
.feature-nav .btn { border-color: transparent; background: transparent; padding: 2px 8px; font-size: 15px; color: var(--muted); }
.feature-nav .btn:hover:not(:disabled) { background: var(--soft-2); color: var(--fg); }
.feature { display: flex; flex-direction: column; gap: 10px; }
.feature-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.badge {
  font: 600 10.5px/1.4 var(--mono); letter-spacing: .04em; padding: 1px 6px; border-radius: 4px;
  background: var(--accent-tint); color: var(--accent-to); border: 1px solid var(--accent-tint-line);
}
.feature-title { font-weight: 600; font-size: 15px; line-height: 1.3; color: var(--fg); }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.step { display: flex; gap: 10px; align-items: flex-start; }
.step input[type=checkbox] {
  appearance: none; -webkit-appearance: none; margin: 2px 0 0; flex: none; width: 16px; height: 16px;
  border: 1px solid var(--line-strong); border-radius: 4px; background: var(--bg); cursor: pointer;
  display: grid; place-content: center;
}
.step input[type=checkbox]::after {
  content: ""; width: 9px; height: 5px; margin-top: -2px;
  border-left: 2px solid var(--bg); border-bottom: 2px solid var(--bg); transform: rotate(-45deg); opacity: 0;
}
.step input[type=checkbox]:checked { background: var(--accent); border-color: var(--accent); }
.step input[type=checkbox]:checked::after { opacity: 1; }
.step input[type=checkbox]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.step-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; color: var(--fg-soft); }
.step.done .step-text { color: var(--muted); text-decoration: line-through; }
.copy { border: 1px solid var(--line); border-radius: 8px; background: var(--soft); overflow: hidden; }
.copy-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 4px 4px 10px; border-bottom: 1px solid var(--line); }
.copy pre { margin: 0; padding: 8px 10px; max-height: 120px; overflow: auto; white-space: pre-wrap; word-break: break-word; font: 11.5px/1.45 var(--mono); }
.pass { padding: 8px 10px; background: var(--ok-tint); color: var(--ok); border-radius: 6px; }
.pass::before { content: "\\2713  "; font-weight: 700; }
.note { color: var(--muted); font-style: italic; }
.error-box { border: 1px solid var(--err); color: var(--err); background: var(--pin-tint); border-radius: 8px; padding: 10px; word-break: break-word; }
.status { font-size: 12px; word-break: break-word; color: var(--muted); }
.status.error { color: var(--err); }
.status.success { color: var(--ok); }
.sent { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--line); padding-top: 12px; }
.sent-item {
  font-size: 12px; display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft);
}
.sent-tag {
  flex: none; font: 600 11px/1.4 var(--sans); padding: 1px 6px; border-radius: 4px; background: var(--pin-tint); color: var(--pin);
}
.sent-item .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
.sent-item .status { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
.sent-item .status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.sent-item .status.error { color: var(--pin); }
.md p { margin: 0; }
.md p + p { margin-top: 4px; }
.md ul, .md ol { margin: 2px 0; padding-left: 18px; }
.md code { font: 11.5px var(--mono); background: var(--soft-2); padding: 1px 4px; border-radius: 4px; }
.md a { color: var(--accent-to); }
a.link {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  padding: 4px 10px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--soft-2);
  color: var(--fg-soft); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
a.link:hover { background: var(--line); }

.layer { position: fixed; inset: 0; z-index: 1; cursor: crosshair; }
.layer.draw { touch-action: none; }
.marks { position: fixed; inset: 0; z-index: 2; pointer-events: none; width: 100vw; height: 100vh; overflow: visible; }
.marks .pin { filter: drop-shadow(2px 3px 3px rgba(0,0,0,.3)); }
.toolbar {
  position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 5;
  display: flex; align-items: center; gap: 4px; padding: 5px 6px; max-width: calc(100vw - 24px); flex-wrap: wrap;
  background: var(--ink); color: var(--ink-fg); border-radius: 18px; box-shadow: 0 8px 24px rgba(0,0,0,.22);
  font-size: 12.5px;
}
.toolbar .btn { border: 0; background: transparent; color: var(--ink-muted); border-radius: 999px; padding: 5px 11px; font-weight: 500; }
.toolbar .btn:hover { background: rgba(255,255,255,.08); color: var(--ink-fg); }
.toolbar .btn.on { background: #fbfaf9; color: #1e1e1e; }
.toolbar .hint { padding: 0 8px 0 10px; color: var(--ink-fg); opacity: .85; }
.toolbar .keys { display: inline-flex; align-items: center; gap: 4px; padding-right: 6px; color: var(--ink-muted); }
.toolbar kbd {
  font: 10px/1 var(--mono); padding: 2px 5px; border-radius: 4px;
  background: rgba(255,255,255,.12); border: 1px solid var(--ink-line); color: var(--ink-fg);
}
.toolbar .sep { width: 1px; align-self: stretch; margin: 4px 2px; background: var(--ink-line); }
.toolbar .status { flex-basis: 100%; padding: 2px 10px 4px; color: var(--ink-fg); }
/* On narrow screens the docked panel would cover most of the page, so it steps
   aside while the reviewer pins or draws; Done in the toolbar brings it back. */
@media (max-width: 719px) {
  .root.commenting .panel { display: none; }
}
/* The toolbar sits above the docked panel, and centres in the space beside it
   when the window leaves enough room. */
@media (min-width: 900px) {
  .root.panel-open .toolbar { left: calc(50% - min(360px, 100vw) / 2); max-width: calc(100vw - min(360px, 100vw) - 24px); }
}
.toolbar .status.error { color: #ff8a80; }
.toolbar .status.success { color: #7ee2a0; }
.composer {
  position: fixed; z-index: 6; width: 320px; max-width: calc(100vw - 24px);
  display: flex; flex-direction: column; gap: 12px; padding: 16px;
  background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow);
}
.composer-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 500; color: var(--fg); }
.composer-badge {
  flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-content: center;
  background: linear-gradient(135deg, var(--accent-from), var(--accent-to)); color: #3a1610; font: 700 10.5px/1 var(--sans);
}
.composer-badge.pen { background: transparent; color: var(--accent); }
.composer textarea {
  width: 100%; min-height: 64px; resize: vertical; border: 1px solid var(--line-strong); border-radius: 8px;
  padding: 8px 12px; background: var(--bg); color: var(--fg); font-size: 14px; line-height: 1.45;
}
.composer textarea:focus { outline: none; border-color: var(--fg); }
.composer-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
.composer-actions .btn:not(.primary) { border-color: transparent; background: transparent; color: var(--fg); }
.composer-actions .btn:not(.primary):hover { background: var(--soft-2); }
.composer-actions .btn.primary { padding: 8px 14px; }
[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) {
  .bubble { transition: none; }
}
`
