// Lives inside the shadow root, so these rules cannot reach the host page and
// page rules cannot reach them. Inherited properties are reset on `.root`
// because the shadow tree still inherits font and color from the host element.
export const STYLES = `
:host { all: initial; }
.root {
  --bg: #ffffff;
  --fg: #18181b;
  --muted: #71717a;
  --line: #e4e4e7;
  --soft: #f4f4f5;
  --accent: #ea580c;
  --accent-fg: #ffffff;
  --ok: #15803d;
  --err: #b91c1c;
  --shadow: 0 10px 30px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.12);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--fg);
  letter-spacing: normal;
  text-align: left;
  text-transform: none;
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .root {
    --bg: #18181b;
    --fg: #f4f4f5;
    --muted: #a1a1aa;
    --line: #3f3f46;
    --soft: #27272a;
    --ok: #4ade80;
    --err: #f87171;
  }
}
.root *, .root *::before, .root *::after { box-sizing: border-box; }
button, input, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
.btn {
  border: 1px solid var(--line); background: var(--bg); border-radius: 8px;
  padding: 6px 10px; line-height: 1.2;
}
.btn:hover { background: var(--soft); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
.btn.primary:hover { filter: brightness(1.05); }
.btn.on { background: var(--fg); border-color: var(--fg); color: var(--bg); }
.icon-btn { border: 0; background: transparent; padding: 4px 6px; border-radius: 6px; color: var(--muted); font-size: 15px; line-height: 1; }
.icon-btn:hover { background: var(--soft); color: var(--fg); }

.bubble {
  position: fixed; right: 16px; bottom: 16px; z-index: 4;
  display: flex; align-items: center; gap: 6px;
  border: 0; border-radius: 999px; padding: 10px 14px;
  background: var(--accent); color: var(--accent-fg); font-weight: 600;
  box-shadow: var(--shadow);
}
.bubble-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .9; }

.panel {
  position: fixed; right: 16px; bottom: 16px; z-index: 4;
  width: min(380px, calc(100vw - 32px)); max-height: calc(100vh - 32px);
  display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: var(--shadow); overflow: hidden;
}
.panel-head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.panel-title { font-weight: 700; flex: 1; }
.target { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.target label { color: var(--muted); white-space: nowrap; }
.target input {
  flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px;
  background: var(--bg); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
}
.panel-body { overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.panel-foot { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); }
.panel-foot .btn { width: 100%; padding: 8px 10px; }

.plan-title { font-weight: 700; font-size: 14px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.feature-nav { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.feature { display: flex; flex-direction: column; gap: 8px; }
.feature-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.badge { font-size: 11px; font-weight: 700; letter-spacing: .04em; padding: 1px 6px; border-radius: 4px; background: var(--soft); border: 1px solid var(--line); }
.feature-title { font-weight: 600; font-size: 14px; }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.step { display: flex; gap: 8px; align-items: flex-start; }
.step input[type=checkbox] { margin: 2px 0 0; accent-color: var(--accent); flex: none; width: 15px; height: 15px; }
.step-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.step.done .step-text { color: var(--muted); text-decoration: line-through; }
.copy { border: 1px solid var(--line); border-radius: 8px; background: var(--soft); overflow: hidden; }
.copy-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 4px 4px 8px; border-bottom: 1px solid var(--line); }
.copy pre { margin: 0; padding: 6px 8px; max-height: 120px; overflow: auto; white-space: pre-wrap; word-break: break-word; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.pass { border-left: 3px solid var(--ok); padding: 4px 8px; background: var(--soft); border-radius: 0 6px 6px 0; }
.note { border-left: 3px solid var(--muted); padding: 4px 8px; }
.error-box { border: 1px solid var(--err); color: var(--err); border-radius: 8px; padding: 8px; word-break: break-word; }
.status { font-size: 12px; word-break: break-word; }
.status.error { color: var(--err); }
.status.success { color: var(--ok); }
.sent { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--line); padding-top: 8px; }
.sent-item { font-size: 12px; display: flex; gap: 6px; }
.sent-item .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md p { margin: 0; }
.md p + p { margin-top: 4px; }
.md ul, .md ol { margin: 2px 0; padding-left: 18px; }
.md code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--soft); padding: 0 3px; border-radius: 3px; }
.md a, a.link { color: var(--accent); }

.layer { position: fixed; inset: 0; z-index: 1; cursor: crosshair; }
.layer.draw { touch-action: none; }
.marks { position: fixed; inset: 0; z-index: 2; pointer-events: none; width: 100vw; height: 100vh; overflow: visible; }
.toolbar {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 3;
  display: flex; align-items: center; gap: 6px; padding: 6px; max-width: calc(100vw - 24px); flex-wrap: wrap;
  background: var(--bg); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow);
}
.toolbar .hint { padding: 0 6px; color: var(--muted); }
.composer {
  position: fixed; z-index: 3; width: 300px; max-width: calc(100vw - 24px);
  display: flex; flex-direction: column; gap: 8px; padding: 10px;
  background: var(--bg); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow);
}
.composer textarea {
  width: 100%; min-height: 84px; resize: vertical; border: 1px solid var(--line); border-radius: 8px;
  padding: 6px 8px; background: var(--bg);
}
.composer-actions { display: flex; justify-content: flex-end; gap: 6px; }
[hidden] { display: none !important; }
`
