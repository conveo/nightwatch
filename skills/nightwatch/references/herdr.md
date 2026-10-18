# nightwatch: Herdr backend reference

Herdr-specific mechanics for nightwatch, phase by phase. Read "Choosing a
backend" in the main `nightwatch` skill first; for Herdr's general CLI, use its
own help (`herdr --help`, `herdr <command> --help`) or the
[Herdr documentation](https://herdr.dev/docs/agent-automation/). This file is only
the nightwatch-specific gotchas on top of it.

## `herdr --remote` is not the bootstrap path

`herdr --remote <ssh-target>` is attach-only to a server that must already be
running there, and it launches the interactive TUI — not callable from a tool
call. It's the Captain's affordance for watching the fleet, not the Helm's way
to reach a box. To reach a box, drive its **own herdr server** over plain SSH.
If `herdr status` on the box shows nothing running, bare `herdr server` (no
`start` subcommand) is the headless entry point.

`herdr --session <name> <subcommand>` targets that named session — creating it
if it doesn't exist — non-interactively. No *subcommand* has a `--session` flag
of its own, and bare `--session <name>` with no subcommand after it drops into
the blocking TUI. To address a session by socket instead:
`HERDR_SOCKET_PATH=<path> herdr workspace list`, with paths from `herdr session
list --json` (`socket_path` per session).

## Phase 3

**Use `bash -l -s`, never bare `bash -s`.** A non-login shell over SSH drops
`GH_TOKEN` and `~/.local/bin` from `PATH` on some remote boxes; the symptom is `git
fetch` failing with "Please make sure you have the correct access rights and
the repository exists" — which reads exactly like a missing deploy key.

**Create the run's worktrees in a dedicated `--session nightwatch`**, not the
box's default session, which may be hosting ad hoc human work. This groups the
run's panes and worktrees under one addressable session and gives Phase 8
cleanup a session-level unit to target alongside the `nw-<scope>-` label prefix.

Both commands run on the box hosting the herdr server:

```bash
herdr --session nightwatch worktree create --cwd <repo-path> --branch <branch> --base <base-ref> \
  --label nw-<scope>-orchestrator --no-focus
# → read the pane id from the response, then:
herdr --session nightwatch agent start orchestrator --kind claude --pane <pane-id> -- --dangerously-skip-permissions
```

For Codex, replace the `agent start` command with:

```bash
herdr --session nightwatch agent start orchestrator --kind codex --pane <pane-id> -- --dangerously-bypass-approvals-and-sandbox
```

Use the same explicit Codex flag for workers, a dedicated Helm, reviewers, and
authorized resumes/replacements. `--approve-for-me` is not YOLO. Follow the
main skill's [Phase 3 launch requirements](../SKILL.md#phase-3--bootstrap-the-field-orchestrator),
including external isolation, scope limits, and effective-mode verification.
The flag goes after Herdr's `--`; do not pass Claude's permission flag to Codex.

Run them bare when the agent doing the bootstrap is already on that box. From
anywhere else, wrap **each** in SSH — wrapping only the first runs `agent
start` on the caller's own machine:

```bash
ssh <user>@<ssh-target> 'bash -l -s' <<'EOS'
export PATH="$HOME/.local/bin:$PATH"
herdr --session nightwatch worktree create --cwd <repo-path> --branch <branch> --base <base-ref> \
  --label nw-<scope>-orchestrator --no-focus
EOS
```

**`herdr worktree create` has no `--env`** (only `pane split`, `tab create`,
and `workspace create` do) — export `NODE_OPTIONS`/`UV_USE_IO_URING` in the
worktree's root pane after creation. **Folder trust is not an env var**: set
`projects["<worktree-path>"].hasTrustDialogAccepted=true` in `~/.claude.json`
on the box hosting the server, before `agent start`. An omitted or wrong
`--base` forks from whatever's checked out.

**Traps:**
- **`herdr pane run` before the pane's shell reaches its prompt no-ops
  silently** — exit 0, no error, nothing runs, the pane's foreground stays a
  bare shell. `agent start` waits for readiness itself; `pane run` doesn't.
  Gate on `herdr pane process-info --pane <id>` (`.foreground_processes[].name`
  still being the shell means not-ready), or poll `pane wait-output` for a
  shell-ready marker.
- **`herdr pane read` returns exit 0 with zero bytes** for ordinary
  (non-alternate-screen) shell panes, while `pane wait-output` against the same
  pane matches correctly — distinct from the documented alternate-screen
  caveat. Gate on `pane wait-output` + `pane process-info`, never `pane read`,
  anywhere in this playbook (Phase 7 included). For a pane hosting an agent
  rather than a plain shell, use `agent read` — see Phase 5.
- **`agent start` on a pane with a nested shell in its foreground fails with an
  undiagnostic `agent_pane_busy: … is not an available shell`.** Assert `pane
  process-info` shows exactly one foreground process whose pid equals
  `shell_pid` first. If it doesn't, create a fresh pane rather than reclaiming
  it (`herdr --session nightwatch pane split --cwd <worktree-path> --env
  KEY=VALUE ... --no-focus`) — `pane split` takes `--env`, so this closes the
  `worktree create` gap above in the same move.

Smaller ones:
- Keep `wait-output --regex` **specific**. A generic alternation like
  `error|Cannot` matches unrelated oh-my-zsh plugin warnings on shell startup;
  anchor on the actual banner text.
- Keep herdr's own `--timeout` **below** whatever tool call wraps it, or raise
  the outer one — `--timeout 150000` inside a 120000ms Bash-tool call is killed
  by the outer tool first, losing the result.
- **Bare `timeout N ssh …` doesn't exist on macOS**, where the Helm runs. Use
  `ssh -o ConnectTimeout=N …`.

## Phase 4: binding and readiness

The receiving daemon drives an **explicit local socket**; it need not be a pane
occupant. Verify socket permissions and CLI access in that daemon's environment.
Remote orchestration still needs authorized SSH or a local mesh actor; local
socket access alone does not prove cross-host reachability.

Capture `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, and the native session at launch.
The common detector compares `agent get <pane>` session identity and
`pane process-info --pane <pane>` foreground PID against the owning runtime
ancestor and process start time. Names are aliases for current occupants; use
pane IDs. Moves/restores/replacements require re-verification and a new binding
generation. Native session metadata requires the relevant Herdr integration;
missing metadata is not permission to guess.

Use the common `agent-mesh` registration with `--deliver auto --dedicated` only
for a pane exclusively owned by that agent, without a human draft. Explicit
binding files contain `{ "type":"herdr", "socket":"/absolute/socket", "pane":"w1:p1" }`.
The daemon uses `HERDR_SOCKET_PATH=<socket> herdr agent prompt <pane> <notification>`;
never substitute `pane run`, `send-text`, Ctrl+C, or dialog responses.

`agent prompt` rejects recognized blocked dialogs. `--wait` observes a state,
not the submitted turn: an already-working turn's completion may satisfy it.
Mesh does not use `--wait`; Claude and Codex working states both defer until idle.
A timeout or other uncertain submission stays ambiguous until receipt or explicit
inspection/retry. No automatic duplicate task execution is promised.

There remains a non-atomic check-to-prompt race and screen detection is fallible.
Support is restricted to dedicated agent panes; automatic reassignment/restoration
under a live binding is outside this contract. An upstream expected-owner guard
would be needed for shared/reused panes. Verify idle receive/receipt/reply and a
clock-only tick before unattended readiness; registration alone is insufficient.

## Phase 5

`herdr agent read <name> --source detection` shows *why* an agent is stuck,
rendering the full dialog including the option list. It **returns plain text,
not JSON**, unlike every other herdr command — don't `jq` it. Use it rather
than `pane read`, which is unreliable (Phase 3 traps).

## Phase 7 — morning reviewer spawn

Run by the designated reachable spawner using the explicit laptop socket:

1. Confirm this is the session you expect: `herdr session list` / `herdr pane
   current --current`.
2. **A reviewer agent pane** — split a sibling pane off the Helm's own (`herdr
   pane split --current --direction right --cwd <worktree-root> --no-focus`),
   pre-seed folder trust in it, then start the agent and give it its first task:
   ```bash
   herdr agent start reviewer --kind claude --pane <new-pane-id> -- --dangerously-skip-permissions
   herdr agent prompt reviewer "register your mesh actor with --deliver auto --dedicated, prove a broker round trip, write the test plan, then wait for review feedback"
   ```
   For a Codex reviewer, replace the `agent start` command with:
   ```bash
   herdr agent start reviewer --kind codex --pane <new-pane-id> -- --dangerously-bypass-approvals-and-sandbox
   ```
   Verify its effective YOLO mode; the flag in the first example is Claude-specific.
   Same common mesh binding and idle receipt proof, and plan-file write from the
   worktree. Keep the managed reviewer process alive; mesh Codex revival is
   unsupported and managed Claude is not automatically resumed.
3. **Dedicated server panes** — sibling panes, same `--cwd`: one for the app's dev
   server, one for the reviewer tool. With this repo's overlay, the tool is
   `pnpm overlay --origin <dev origin> --target <reviewer's mesh id> --plan <worktree-root>/untracked/review-plan.json`,
   run from your nightwatch clone; or use your own tool that sends `ui-review`
   notes.
   ```bash
   herdr pane split --current --direction down --cwd <worktree-root> --no-focus   # once per pane
   herdr pane run <server-pane-id> "<start your app's dev server>"
   herdr pane run <tool-pane-id> "cd <nightwatch clone> && pnpm overlay --origin <dev origin> --target <reviewer's mesh id> --plan <worktree-root>/untracked/review-plan.json"
   ```
   A separate pane the reviewer agent's process doesn't own survives that
   agent's turn boundaries, the same way a dedicated terminal does. The tool's
   pane needs `agent-mesh` on `PATH`, as on the Superset path.

## Phase 8 — cleanup

Retire the exact run actors with their current mesh generations before closing
panes; retirement preserves inboxes and cancels daemon ticks. Never drain comments
as cleanup. Keep the run manifest of socket/pane IDs and ownership evidence.

Whoever runs this step (the Helm on the laptop, the field orchestrator on its
own box) must target the explicit socket/session owning the resources it
created: `herdr --session
nightwatch pane close <id>` for one-off panes, `herdr --session nightwatch
worktree remove --workspace <id>` for a ticket's worktree. Find them by the
exact `nw-<scope>-` label prefix from Phase 3 (`herdr --session nightwatch
workspace list` / `pane list`) — the `nightwatch` session isolates this run
from unrelated work on the box, but **not** from a second, still-live
nightwatch run sharing that session, so never sweep the bare `nw-` prefix.
Stopping or deleting the session itself (`herdr session stop nightwatch` /
`herdr session delete nightwatch`) is the human's call, once no other run is
using it.
