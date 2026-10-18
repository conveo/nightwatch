# reviewer-overlay

A review overlay for web apps in development. A person opens the app, follows a
test plan, drops a numbered pin on the page, writes a note and clicks Send. The
note, a screenshot with the pin drawn on it, and the page details go to an agent
on [agent-mesh](../agent-mesh) as a `ui-review` note.

It has two parts:

- **A browser script.** One `<script>` tag or one import. No framework needed.
  It renders inside a Shadow DOM, so the app's CSS does not change it and it
  does not change the app.
- **A local server.** Plain Node, one dependency (zod). It serves the test plan
  and the script, accepts the review, stores the screenshot, and publishes the
  note with the `agent-mesh` CLI.

```
browser (your app + overlay) --POST--> local server --agent-mesh publish--> agent inbox
```

## Requirements

- Node 22.18 or newer (the server runs its TypeScript source directly).
- pnpm.
- A running agent-mesh daemon and its CLI (see the
  [quickstart](../README.md#quickstart-about-5-minutes)). The target agent must
  read its inbox.
- A Chromium-based browser for screenshots. Other browsers can send notes
  without a screenshot (see [Screenshots](#screenshots)).

## Use it in 3 steps

1. **Start the server.** From the repository root, pass your app's dev origin
   and the agent that should get the notes.

   ```bash
   pnpm install
   pnpm overlay --origin http://localhost:3000 --target my-agent
   ```

   `pnpm overlay` builds the browser script and starts the server in
   `reviewer-overlay/`. If `agent-mesh` is not on your `PATH`, point to this
   repo's CLI: `--mesh-cli "pnpm --dir ../agent-mesh exec tsx src/cli.ts"`.
   The path is relative to `reviewer-overlay/`, so it names the `agent-mesh/`
   directory at the repository root.

2. **Add the script to your app, in development only.**

   ```html
   <script src="http://127.0.0.1:4848/reviewer-overlay.js" defer></script>
   ```

   Or from a module:

   ```js
   if (import.meta.env.DEV) {
     const { init } = await import("http://127.0.0.1:4848/reviewer-overlay.mjs")
     init({ server: "http://127.0.0.1:4848" })
   }
   ```

3. **Review.** Open the app and click **Reviewer** (bottom right). Check off
   plan steps as you go. Click **Add comment** and allow sharing of this tab
   once. Click the page to drop a pin, write a note, and click **Send**
   (or press Ctrl/Cmd+Enter). Use **Draw** to circle things. The status line
   shows the mesh message id, or the reason the note was not delivered.

The agent reads the note from its inbox, for example with
`agent-mesh watch` or `agent-mesh inbox`.

## Test plan

The server reads the plan from `--plan` (default `untracked/review-plan.json`)
on every request. Edit the file and press the reload button in the panel. If
the file is missing, the panel says so and comments still work.

Relative `--plan` and `--report-dir` paths resolve against the directory you ran
the command in (pnpm's `INIT_CWD`), not `reviewer-overlay/`. To read a plan from
another worktree, pass its absolute path.

```json
{
  "title": "Settings page · verify",
  "subtitle": "Short context. **Markdown** works here.",
  "features": [
    {
      "id": "f1",
      "title": "Save button label",
      "badge": "VERIFY",
      "ticket": "ABC-12 · #345",
      "tag": "instant",
      "url": "/settings",
      "intro": "One sentence about what changed.",
      "steps": [
        "A plain step.",
        {
          "text": "A step with something to copy:",
          "copy": [{ "kind": "command", "label": "shell", "text": "grep -n 'Save' src/settings.tsx" }]
        }
      ],
      "pass": "The pass criterion, as a yes/no question.",
      "note": "An optional caveat."
    }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `title`, `subtitle` | string | `subtitle` renders markdown. |
| `appBase` | string | Accepted and ignored. The overlay runs inside the app. |
| `features[]` | object | One feature is shown at a time, with ‹ › to switch. |
| `features[].id` | string | Keys the check-off state. Defaults to the position. |
| `features[].title`, `badge`, `ticket`, `tag` | string | Plain text. |
| `features[].url` | string | Shown as a link. Resolved against the current page. Only http(s). |
| `features[].intro`, `note` | string | Markdown. |
| `features[].steps[]` | string or `{ text, copy? }` | `text` renders markdown. |
| `steps[].copy[]` | `{ kind?, label?, text }` | Shown as a block with a Copy button. |
| `features[].pass` | string | Plain text. |
| `steps` (top level) | array | A flat plan. Renders as one feature. |

Every field is optional and unknown fields are kept. The markdown subset is
`**bold**`, `` `code` ``, `[links](url)`, and `-` / `1.` lists. It is rendered
with text nodes only. Links must be http, https or mailto.

Check-off state is stored in `localStorage`, per plan title and step text.

## Message contract

The server publishes one agent-mesh message per review:

```bash
agent-mesh publish --id <reporter-id> --to <target> --type note --corr ui-review --body '<body>'
```

Envelope:

| Field | Value |
| --- | --- |
| `type` | `note` |
| `correlationId` | `ui-review` |
| `from` | `--reporter-id` (default `reviewer-overlay`) |
| `to` | `--target`. With `--allow-target-override`, the id typed in the panel. |

Body:

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | `"ui-review-comment"` | |
| `comment` | string | What the reviewer wrote. May be empty for a pin-only or drawing-only note. |
| `url` | string | The page. |
| `pin` | `{ n, xPct, yPct, pageX, pageY }` or null | `xPct`/`yPct` are % across/down the viewport in the screenshot. `pageX`/`pageY` are document pixels. |
| `meta` | `{ title, viewport: { w, h, dpr }, userAgent }` or null | |
| `reporter` | null | No sign-in in this tool. |
| `strokes` | `[{ points: [{ xPct, yPct }] }]` or null | Freehand lines in % coordinates. Only sent when there is no screenshot; otherwise they are drawn into it. |
| `screenshot` | string or null | Absolute path of the PNG on the reviewer's machine. Null when capture failed. |
| `screenshotUrl`, `screenshotBucket`, `screenshotKey` | null | Part of the `ui-review` contract in the [human-review skill](../skills/human-review/SKILL.md), for tools that upload screenshots. This tool has no remote storage, so they are always null. |
| `capturedAt` | string | ISO time from the browser. |
| `note` | string | Instructions for the agent, including how to reply. |

A message the listener received in the end-to-end test:

```json
{
  "id": "1792146203255-0",
  "from": "reviewer-overlay",
  "to": "e2e-listener",
  "type": "note",
  "correlationId": "ui-review",
  "body": {
    "kind": "ui-review-comment",
    "comment": "The save button label is cut off: it reads SAVE ALL WORKSP...",
    "url": "http://127.0.0.1:35593/",
    "pin": { "n": 1, "xPct": 24.8, "yPct": 68.7, "pageX": 318, "pageY": 412 },
    "meta": { "title": "Demo app · Settings", "viewport": { "w": 1280, "h": 600, "dpr": 1 }, "userAgent": "Mozilla/5.0 ..." },
    "reporter": null,
    "strokes": null,
    "screenshot": "/path/to/untracked/review-overlay-report/review-20261016102322994-1dfc7670-....png",
    "screenshotUrl": null,
    "screenshotBucket": null,
    "screenshotKey": null,
    "capturedAt": "2026-10-16T10:23:22.981Z",
    "note": "Reviewer overlay feedback. ..."
  }
}
```

The agent replies on the same thread with
`agent-mesh publish --to reviewer-overlay --type note --corr ui-review --reply <id> --body '{"text":"..."}'`.
The overlay does not show replies yet.

The server also writes `<id>.json` next to each screenshot with the full
message and the delivery result (`pending`, `published` or `failed`). If a
publish fails, the note is still on disk.

## Server options

```
node src/server/main.ts --origin <url> --target <agent-id> [options]
```

| Option | Default | Notes |
| --- | --- | --- |
| `--origin <url>` | required | Your app's dev origin. Repeat for more. Env `REVIEWER_OVERLAY_ORIGINS` (comma-separated). |
| `--target <agent-id>` | required | Env `REVIEW_TARGET_AGENT_ID`. |
| `--port <n>` | `4848` | Always on 127.0.0.1. Env `REVIEWER_OVERLAY_PORT`. |
| `--reporter-id <id>` | `reviewer-overlay` | Mesh id the notes come from. |
| `--plan <path>` | `untracked/review-plan.json` | |
| `--report-dir <path>` | `untracked/review-overlay-report` | Screenshots and report copies. |
| `--mesh-cli <command>` | `agent-mesh` | A JSON array keeps arguments with spaces. Env `REVIEWER_OVERLAY_MESH_CLI`. |
| `--publish-timeout-ms <n>` | `15000` | |
| `--max-body-mb <n>` | `32` | Request size cap. |
| `--allow-host <name>` | none | Extra `Host` header names, e.g. a forwarded hostname. |
| `--allow-target-override` | off | Show an agent id field in the panel and send each note to the id typed there. Without it, every note goes to `--target`. |

On start the server runs `agent-mesh health` and prints a warning if the
daemon does not answer.

## HTTP API

| Request | Response |
| --- | --- |
| `GET /reviewer-overlay.js` | The classic script bundle. |
| `GET /reviewer-overlay.mjs` | The ES module bundle. |
| `GET /api/review` | `{ enabled, canChooseTarget, targetAgentId, plan, planError }` |
| `POST /api/review` | `200 { ok: true, delivered, meshMessageId, targetAgentId, screenshotPath, reportPath }` |
| | `502 { ok: false, error: "publishFailed", message, screenshotPath, reportPath }` |
| | `400`, `403`, `413`, `415` `{ ok: false, error, message }` |

The POST body is
`{ comment, url, pin, meta, screenshotDataUrl, capturedAt, targetAgentId, strokes }`.
`screenshotDataUrl` is a `data:image/png;base64,...` URL or null. The server
ignores `targetAgentId` unless it runs with `--allow-target-override`.

## Security

The server accepts screenshots of your app and starts a local process, so it
is strict:

- It listens on 127.0.0.1 only.
- It rejects any `Host` header that is not `127.0.0.1`, `localhost`, `[::1]`
  or an `--allow-host` name. This blocks DNS rebinding.
- CORS allows only the `--origin` list. A POST without an allowed `Origin` is
  refused. The page `url` in a review must also be on an allowed origin.
- POST bodies must be `application/json` and are capped (`--max-body-mb`).
- Bodies are validated with zod. The screenshot must decode to a real PNG
  with sane dimensions.
- File names come from the server clock and a random UUID. Nothing from the
  request is used in a path. Files are created with mode 0600 and never
  overwritten.
- The agent-mesh CLI is run without a shell. Agent ids must match
  `[A-Za-z0-9._-]{1,128}`.
- By default every note goes to `--target`, and the agent id in the request is
  ignored. Otherwise any script on an allowed origin could send notes to any
  agent id. Use `--allow-target-override` only when you need to pick the target
  in the panel.

Only add the script in development builds.

## Screenshots

The overlay captures the viewport with `getDisplayMedia` (tab sharing). This
gives an exact picture, including cross-origin images and web fonts. The
browser asks once per comment session. Chrome and Edge preselect the current
tab. The overlay hides itself for the capture and draws the pin and lines onto
the image.

- If sharing is refused or unavailable, notes still send, without a screenshot.
  Drawn lines are then sent as vector `strokes`.
- Firefox and Safari share a window or screen, not the tab. The pin can be
  offset. The overlay warns when the frame does not match the viewport.
- To turn capture off: `data-capture="none"` on the script tag, or
  `init({ server, capture: "none" })`.
- To use your own capture, pass a function that returns a PNG data URL (or
  null). It runs while the overlay is hidden. The image must show the visible
  viewport at the current scroll position, because the pin is placed by
  viewport percentage. A DOM-to-image library that renders from the top of the
  document puts the pin in the wrong place on a scrolled page.

  ```js
  init({
    server: "http://127.0.0.1:4848",
    capture: async () => myViewportScreenshot(), // "data:image/png;base64,..."
  })
  ```

## Script tag options

| Attribute | Meaning |
| --- | --- |
| `data-server` | Server base URL. Default: the origin the script was loaded from. |
| `data-capture="none"` | Send notes without screenshots. |
| `data-open="true"` | Start with the panel open. |
| `data-auto="false"` | Do not start. Call `window.ReviewerOverlay.init(...)` yourself. |

## Limits

- Comment: 4,000 characters. Page url: 4,096. Title and user agent: 512 each.
- Drawing sent as vectors: 32 lines, 1,000 points per line, 2,000 points in
  total. The note goes to `agent-mesh publish` as one command-line argument,
  and Linux caps one argument at 128 KiB. The server refuses a note over
  120,000 bytes.

## Development

From the repository root:

```bash
pnpm install
pnpm --dir reviewer-overlay test        # server and markdown unit tests (node:test)
pnpm --dir reviewer-overlay typecheck
pnpm --dir reviewer-overlay build       # dist/reviewer-overlay.js (ESM) and dist/reviewer-overlay.iife.js
```

The end-to-end test starts a throwaway Redis in Docker, an agent-mesh daemon on
it, a listener agent, this server, the demo page in `demo/`, and headless
Chrome driven by [agent-browser](https://github.com/vercel-labs/agent-browser).
It drops a pin, sends a note, and checks that the listener got it with a PNG.
Everything it starts is stopped and removed at the end. It uses this repo's
`agent-mesh/`; set `AGENT_MESH_DIR` to use another agent-mesh checkout.

```bash
bash reviewer-overlay/e2e/run.sh
# if Chrome aborts at start (containers, some Linux hosts), add CHROME_FLAGS="--no-sandbox"
```

## Not in this version

- Agent replies shown in the panel.
- Remote screenshot storage. Agents on another machine cannot open the
  `screenshot` path.
- Sign-in, or a record of who sent a note (`reporter` is always null).
- A log of sent notes that survives a reload.
- Moving the Reviewer button.
- DOM capture built in. Use a custom capture function instead.

## License

MIT. See [LICENSE](../LICENSE) at the repository root.
