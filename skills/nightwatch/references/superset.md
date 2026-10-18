# Nightwatch: Superset CLI

Use the CLI in the actual daemon/spawn environment. MCP is optional, not a
cross-host requirement. Verified installed help: 1.26.0. Recheck `--help` when
upgrading. [Official CLI reference](https://docs.superset.sh/cli/cli-reference).

## Operations

Always route remote work with explicit `--host`. Include `--workspace` and
`--terminal` where relevant, and use `--json` to retain returned identifiers.

| MCP operation | CLI counterpart |
| --- | --- |
| `hosts_list` | `superset hosts list --json` |
| `projects_list` | `superset projects list --host <host> --json` |
| `workspaces_list` | `superset workspaces list --host <host> --json` |
| `workspaces_create` | `superset workspaces create --host <host> --project <project> --branch <branch> --base-branch <base> --name <name> --json` |
| `workspaces_update` | `superset workspaces update <id> --host <host> --name <name> --json` |
| `workspaces_delete` | `superset workspaces delete <id> --host <host> --json` |
| `agents_list` | `superset agents list --host <host> --json` |
| `agents_create` | `superset agents create --host <host> --workspace <workspace> --agent <preset> --prompt <prompt> --json` |
| `terminals_create` | `superset terminals create --host <host> --workspace <workspace> --cwd <worktree> --json` |
| `terminals_list` | `superset terminals list --host <host> --workspace <workspace> --json` |
| `terminals_send` | `superset terminals send --host <host> --workspace <workspace> --terminal <terminal> --text <text> --json` |
| `terminals_read` | `superset terminals read --host <host> --workspace <workspace> --terminal <terminal> --json` |
| `terminals_close` | `superset terminals close --host <host> --workspace <workspace> --terminal <terminal> --json` |

`agents list` lists **presets**, not running agents. `terminals list` lists
terminals, not responsive models. The terminal is the `sessionId` returned by a
terminal agent launch, not necessarily its native conversation ID. Built-in
Superset chat sessions are not terminal targets.

## Phase 3: launch

Select configured Claude/Codex presets explicitly. Installed `agents create` and
`workspaces create` support `--effort` but not `--model`; select model configuration
through a preset and do not invent flags from newer docs. CLI workspace creation
accepts one `--agent`/`--prompt`; MCP/SDK support an `agents` array. Launch extra
agents through separate `agents create` calls, respecting the fleet concurrency cap.

Every Codex nightwatch preset must explicitly launch with
`--dangerously-bypass-approvals-and-sandbox` (`--yolo`), including workers,
reviewers, and authorized resumes/replacements. Verify the actual command and
effective mode; `--approve-for-me` is not equivalent. Follow the main skill's
[Phase 3 launch requirements](../SKILL.md#phase-3--bootstrap-the-field-orchestrator).
Select a compliant run-specific preset or supported dedicated terminal command;
do not invent a `--yolo` flag for `superset agents create` or change global presets.

Specify base branch and verify it on disk before work. Capture host, workspace,
terminal launch ID, cwd, preset, and native session identity when reported. Pass
the actor ID and common mesh registration instructions in the launch prompt.
Installed hook templates reference `SUPERSET_TERMINAL_ID`, workspace, tab, and
pane IDs; this establishes that the variable exists in those integrations, not
that every session inherits it or that it fences the current occupant.

## Phase 4: readiness

Prove `hosts list`, target project/workspace visibility, and preset access in the
real spawner environment. An interactive terminal's cached auth is not proof the
daemon has the same access. No MCP installation or OAuth troubleshooting is needed.

Use common registration: `agent-mesh register --role orchestrator --deliver auto
--dedicated --tick 15`, then `agent-mesh delivery` and a real receive/receipt/reply
challenge. Claude and Codex terminal delivery are implemented; built-in chat is
not a target. For Claude, use a terminal launch with
`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` in that runtime's environment. The
probe reports `prompt-suggestions-enabled` otherwise: suggested input is
indistinguishable from a draft in the text snapshot. CLI `agents create` has no
per-launch `--env`; use a configured preset with that environment, or a dedicated
`terminals create --command` launch carrying the variable and the verified preset's
command/arguments. Do not edit global presets as an implicit setup step. See
[Claude's environment reference](https://code.claude.com/docs/en/env-vars).

The detector uses the runtime's inherited workspace/terminal IDs,
`superset status --json` for the local host, and the host's local agent-binding API
for native-session/lifecycle evidence. Its existing local manifest token stays in
memory and is sent only to that loopback service. No MCP setup is involved.

The daemon checks PID/start time, controlling terminal, binding/native session,
and the current composer from `terminals read`, then submits using `terminals
send`. Working/blocked/unknown states and visible drafts defer. The supported
empty Codex composer currently uses `Ask Codex to do anything`; other layouts
fail closed until verified. Claude's native ID can be resolved from the verified
host binding when its process does not export `CLAUDE_CODE_SESSION_ID`.

Preflight and submission are not atomic. Keep terminals dedicated: no human
editing, terminal reuse, or another sender while bound. A human draft equal to a
placeholder cannot be distinguished by the text snapshot. Inspect changed
layouts/owners and deliberately rebind; never force input past a dialog or clear
a draft. CLI exit zero is submission, not receipt. See the canonical
[delivery contract](../../../docs/DELIVERY.md) and its
[live proof](../../../docs/VERIFICATION.md).

## Phase 7: reviewer and server

Launch the selected local reviewer preset in the intended worktree. The reviewer
registers its own session-specific mesh actor (`agent-mesh register --role reviewer
--deliver auto --dedicated`), checks a real broker round trip on a unique throwaway
id (a daemon socket that answers does not prove the broker is reachable), and prints
`agent-mesh delivery`. Separately prove that the intended reviewer receives, ACKs,
and replies while idle.

Create independent server terminals with explicit cwd
(`superset terminals create --host <host> --workspace <workspace> --cwd <worktree>`):
one for your app's dev server, one for the reviewer tool. With this repo's overlay,
run `pnpm overlay --origin <dev origin> --target <reviewer's mesh id> --plan
<worktree>/untracked/review-plan.json` from your nightwatch clone; or start your own
tool that sends `ui-review` notes (see the `human-review` skill). The tool's terminal
needs `agent-mesh` on `PATH`; it does not inherit the launcher's exports. The
reviewer writes `untracked/review-plan.json` in that worktree and stays alive for
feedback. An exited reviewer is unavailable even if the server is still healthy.

## Phase 8: cleanup

Use the exact run manifest and `nw-<scope>-` prefix. Retire only those mesh actor
bindings on their owning hosts, preserving mail and cancelling timers. Close only
recorded run terminals/workspaces via explicit host/IDs once cleanup is authorized.
Do not sweep all `nw-` workspaces or restart the shared daemon. CLI cross-host
access can perform cleanup; MCP is not required.
