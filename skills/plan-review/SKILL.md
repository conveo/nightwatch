---
name: plan-review
description: Collaborative plan review — open a plan doc (markdown, or HTML with mockups/wireframes) in the agent-mesh dashboard's "Plans" tab, let a human select-and-comment on any text or image, and a planner agent iterates the plan live over the agent mesh. Use when refining a plan with a human in the loop before building — especially as the Phase-1 step of a /nightwatch run. The plan-time analogue of /human-review.
---

# plan-review: refine a plan with a human, over the mesh

`/human-review` lets a human test the running *app* and send pinned-screenshot
feedback to the mesh. **plan-review is the same loop one phase earlier** — the
human reviews a **plan document** in the dashboard's **Plans tab**, selects any
text or image, comments, and a **planner** agent revises the plan live.

```
 you (planner) ──author plan──▶ dashboard Plans tab ──human selects text/image + comments──▶ your inbox ──you revise the plan
```

It is a tab in the agent-mesh dashboard (`agent-mesh/dashboard`), so it shares
the dashboard's styling and publishes comments through the dashboard's existing
mesh path. It is the plan-time twin of `human-review`.

## Rule zero: the plan is the artifact

The human reviews the **real plan you'll hand to the build** — not a summary.
Edits you make land in the plan file; the human refreshes the tab and sees them
(the server re-reads the plan per request). Keep one canonical plan; don't fork a
review-only copy.

## Requirement: the agent mesh

This is the planner end of the **[agent-mesh](../agent-mesh/SKILL.md)**. It only
works if the mesh daemon is up and you are **registered as the planner** (see the
`agent-mesh` skill for bootstrap, identity pinning, and verified delivery). On a laptop
that also means the broker is reachable (for a remote broker, usually over a VPN).

## A. Author a reviewable plan — do this first

Write the canonical plan as markdown, for example `plans/YYYY-MM-DD-<slug>.md` in
the repository you are planning for (diffable, reviewable in a PR). When the plan benefits from **visuals** — a UI redesign,
before/after states, option comparisons — also author an **HTML sibling**
(`.html`, same slug); the Plans tab renders it as-is so you get full layout
control.

Conventions that make an HTML plan read as one product family and stay
commentable:

- **NEVER ship global styles.** The plan HTML is injected into the live
  dashboard DOM, not loaded in its own page — so a `<!doctype>`/`<html>`/`<body>`
  wrapper, a bare `body {}`/`html {}`/`* {}` rule, or any hardcoded
  `background`/`color` on a global selector **hijacks the whole dashboard** (e.g.
  forces dark mode for everyone). Author the plan as a **fragment**: one
  `<style>` block whose every selector is prefixed with your wrapper class
  (`.pr-doc h1`, `.pr-doc *`, …) and a single `<div class="pr-doc">…</div>`.
- **Scope styles under that wrapper class** and pull every color from the
  **agent-mesh dashboard tokens** (the `:root` / `.dark` oklch vars in
  `agent-mesh/dashboard/src/index.css` — `--background`, `--foreground`,
  `--card`, `--border`, `--muted-foreground`, `--primary`, `--status-*`, …) so
  the doc inherits the host's light/dark theme instead of fighting it. No raw
  hex/oklch literals for themed surfaces; map semantic accents onto `--status-*`.
- **Keep real `<h1>`–`<h6>` headings** — each comment's *anchor* is the nearest
  preceding heading.
- **Show, don't just tell:** build mockups/wireframes as HTML/CSS "browser-frame"
  blocks (selectable text) and/or sibling SVGs referenced via `<img>` — the server
  serves sibling files from the plan's own directory (`/api/plan-asset`), so
  `<img src="assets/foo.svg">` works and images are individually commentable.
  This is where HTML earns its keep over markdown, and where commenting on an
  image matters.
- **Design restraint** (the plan renders inside the dashboard, so match its
  style): progressive disclosure, **don't
  overuse cards** (hierarchy via type/spacing/dividers), **no emoji** — lucide-style
  inline SVG icons, light/dark parity.

## B. Open the plan in the dashboard's Plans tab

The dashboard is **one global server per host** (not per session/worktree). Start
it once per host if it isn't already running:

```bash
pnpm --dir "$NIGHTWATCH_HOME/agent-mesh" ui        # http://127.0.0.1:4747
```

`NIGHTWATCH_HOME` is your clone of the nightwatch repository.

Then deep-link straight to the plan. **Use an ABSOLUTE plan path** — the dashboard
is global and plans live in many different worktrees, so an absolute path is the
only thing that resolves regardless of where the server was launched:

```
http://127.0.0.1:4747/?view=plans&plan=/abs/path/to/<worktree>/plans/<file>.html&to=planner
```

The server listens on 127.0.0.1 only and has no authentication, so there is no
option to bind it to a network address. When it runs on a remote host, tunnel to
it from the laptop and use the same link:

```bash
ssh -N -L 4747:127.0.0.1:4747 <remote-host>   # any free local port works
```

`to=` is the planner mesh id comments go to (default `planner`). Reads are bounded
to `.md`/`.markdown`/`.html`/`.htm` files whose **real** path (symlinks followed)
is inside the dashboard's checkout, one of that repository's git worktrees, or a
directory listed in `AGENT_MESH_PLANS_ROOTS`. A plan anywhere else (e.g. `/tmp`)
gets a 404 with the reason and the allowed roots. A *relative* `plan=` resolves
against `AGENT_MESH_PLANS_ROOT` (default: the checkout the dashboard runs from) — a
single-checkout dev convenience only; prefer absolute paths for the real,
shared-host topology. The current base + a not-found path are shown in the tab.
Plans are sanitized before they render: scripts, event handlers, forms, iframes
and external stylesheets are dropped; inline `<style>` and `style=` survive.

## C. Bind the planner and prove delivery

Follow the common [agent-mesh setup](../agent-mesh/SKILL.md): register a fresh,
dedicated planner ID with `--deliver auto`, inspect the selected mode, and verify
an idle native-session receive/receipt/reply. Use that exact ID in `to=`. Claude
and Codex share this protocol. Manager addresses never enter plan publisher code.

Do not consume pending comments during setup. Broker selfchecks use throwaway
identities; the real target's receipt proof accepts only a batch the planner has
actually read. An unavailable backend preserves mail; polling-only means comments
wait for an active turn and is not a live-review readiness pass. Monitor is an
explicit legacy fallback only when the harness exposes it.

## D. Act on each comment — in the receiving turn

Each comment arrives as a mesh message (published by the dashboard from `operator`
on corr `plan-review`) whose body is:

```json
{ "plan": "<file>", "planPath": "<abs path>", "anchor": "<nearest heading>",
  "quote": "<selected text, or [image] <alt/name>>", "comment": "<note>", "ts": "<iso>" }
```

Deduplicate by message channel+ID, preserving comment/thread identity. Read the `quote` + `anchor`, make the edit in the plan file, and move on. The
human refreshes the tab to see it. **The loop is one-way**: your replies don't
show in the tab, so tell the human what you changed in chat (or over the mesh).

## E. Hand off to the build

When the human is happy and committing is authorized, **commit the plan** and hand its path to the builder. In
a `/nightwatch` run this IS Phase 1 — give the field orchestrator the (absolute or
repo-relative) plan path so its workers read it.

## Gotchas

- **One global dashboard per host.** Don't expect a per-session server; deep-link
  the shared one with an **absolute** plan path. Don't try to fix paths by
  restarting the global server with a different `AGENT_MESH_PLANS_ROOT` — that
  only moves the relative base, and a shared server can't have a per-plan base.
- **HTML plan images** must be sibling files under the plan's directory (served by
  `/api/plan-asset`) or `data:` URIs — absolute `file://` won't load.
- The Plans tab is a local development tool with no authentication. Do not expose
  it beyond loopback or an SSH tunnel.

## Where this fits

- **`human-review`** — the same loop for the running app (Phase 7 of nightwatch).
- **`agent-mesh`** — the substrate (register/receive/receipt/publish, identity, liveness).
- **`nightwatch`** — the afternoon→morning fleet; plan-review is its Phase-1
  human-in-the-loop plan-refinement step.
- Implementation: `agent-mesh/dashboard/src/components/PlansView.tsx` +
  `agent-mesh/src/ui-server.ts` (`/api/plan-read`, `/api/plan-asset`).
