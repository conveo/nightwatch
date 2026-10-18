# agent-mesh — the host supervisor

`agent-mesh/supervisor.sh` is what keeps a host on the mesh for days without a human:
a single pass every 5 minutes (launchd on macOS via `lib/install-supervisor.sh`,
cron on Linux) that keeps the daemon and dashboard **alive and current**. It
restarts them when they stop answering, and when the checkout's `agent-mesh/` code
is newer than the code they run. It does not pull `main` unless you turn on sync
(`AGENT_MESH_SUPERVISOR_SYNC=1`, see step 3). Read alongside `RESILIENCE.md` (what
the daemon does for itself) and `DELIVERY.md` (what a restart does to bindings).

## Who is responsible

A supervised host has one accountable actor: the host's orchestrator (Helm on the
laptop, the field orchestrator on a remote box). That actor
**owns the mesh services on its host**, not just the work it dispatches:

- it installs and keeps the supervisor pointed at the base checkout
  (`./agent-mesh/lib/install-supervisor.sh` from base `main`);
- on every tick it verifies a pass actually ran and finished — a wedged pass (a
  `supervisor.sh` process older than a couple of minutes) is killed with its
  children and the job kickstarted; a sleep gap is not a wedge;
- it treats "healthy" and "current" as two different questions. The supervisor
  answers both, but the orchestrator checks `supervisor.log` for `restart:` lines
  and re-establishes its own delivery after one (below);
- with sync on, it repairs what the script refuses to touch by design (a diverged
  `main`, an untracked file it did not create) and only then involves a human.

Reporting a daemon as healthy while it runs stale code is the failure this file
exists to prevent. A health probe shows that the daemon answers, not which code it
runs, so a daemon can pass it for days on old code.

## What one pass does, in order

1. **Daemon liveness** — `agent-mesh health` through the repo's own tsx. Two
   consecutive failed probes (across two passes) before a restart, and no restart
   or strike at all while the broker host does not resolve. A laptop that wakes
   briefly with no network can fail one probe while its daemon is healthy, and a
   restart then leaves no daemon until the broker is reachable again, because the
   daemon connects to Redis *before* it binds its socket.
2. **Dashboard liveness** — `:4747` answers or the UI is restarted; the dashboard
   is built only when `dashboard/dist` is missing.
3. **Sync base `main`** — only with `AGENT_MESH_SUPERVISOR_SYNC=1`; off by default.
   Fast-forwarding to `origin/main` means running whatever is pushed to `main`,
   unattended. On a clone of a public repo, that is code other people pushed. Turn
   it on only for a checkout whose `origin` you control. Set the variable when you run
   `lib/install-supervisor.sh` (it writes the value into the launchd job), or put it
   on the cron line. With sync on: `git fetch` under a 60s wall-clock deadline, then
   `git merge --ff-only` under a 120s one. Both deadlines are real: git's own
   knobs do not cover a DNS/TCP stall, and a slow checkout (for example one with
   Git LFS files) can wait on the network too. Skipped when the checkout is dirty
   or not on `main`. A merge that hits its deadline is undone (see below) so the
   next pass can retry instead of skipping forever.
4. **Mesh-code currency** — the commit that last touched `agent-mesh/` is recorded
   in `~/.agent-mesh/daemon.commit` when the daemon is launched here. When the
   checkout carries a newer one (after a sync, or after you pull by hand) and the
   daemon is healthy and online, the daemon and UI are restarted onto it. This step
   runs with sync off too. The dashboard is rebuilt only when
   `agent-mesh/dashboard/` changed, with vite's JS entry under the same node. The
   script cannot install dashboard dependencies: a rebuild that needs a new one
   fails, the previous build keeps being served, and `supervisor.log` says to
   install the dashboard's dependencies once by hand. A daemon started outside the
   script has no record and is adopted as current on the first pass rather than
   bounced.
5. **CLI wrapper** — `~/.local/bin/agent-mesh` is compared with what the installer
   would write from this checkout and reinstalled on any difference: a wrapper
   moved to a worktree by an agent's bootstrap, or one that predates a change to
   the wrapper itself. A wrapper that points at a worktree breaks every CLI call on
   the host when that worktree is deleted, and runs old commands when the worktree
   is on an old branch. Run a worktree's CLI directly with
   `cd <worktree>/agent-mesh && node ../node_modules/tsx/dist/cli.mjs src/cli.ts …`
   instead. The wrapper runs the CLI with node and the checkout's tsx, and falls
   back to pnpm only when the checkout has no tsx: a `packageManager` pin the host
   cannot honour yet would otherwise take every agent's CLI down at once, and
   pnpm 12 runs a full workspace install before every `exec`.

## What a restart costs, and what to do after one

A daemon restart — from liveness or from currency — kills every legacy
`agent-mesh watch` on the host; managed adapter/polling bindings are restored by
the daemon from local persistence (`DELIVERY.md`). So after any `restart:` line in
`supervisor.log`:

- an orchestrator on a legacy Monitor watch stops the old Monitor and re-arms
  `agent-mesh watch --id <id> --tick 15`, then proves the round trip with a
  self-published note;
- an orchestrator on a managed binding checks `agent-mesh delivery` and a
  receipted tick.

Never test the restart path against the real daemon — stub `healthy`,
`kill_daemon`, `start_daemon` in a scratch copy of the script.

## Aborted merge recovery

This applies only with sync on. Killing a ff-only merge mid-checkout leaves tracked
files half-updated with `HEAD`
unmoved; every later pass then logs `sync: skip (dirty)` and the checkout stops
following `main` while everything else keeps reporting healthy. The pass that
aborted the merge undoes only what it can prove the merge wrote, path by path — a
human may have edited a file during the merge window, and that edit survives:

- a modified or untracked path whose content hashes to the `origin/main` blob
  (`git hash-object --path`, which applies the same clean filters as `git add`)
  was written by the merge → restored from `HEAD` / removed;
- a deletion `origin/main` also makes was the merge's → restored from `HEAD`;
- anything else stays and is counted in the log line as `left N for a human` —
  including a file the merge was still writing when it was cut off, which then
  keeps the sync on `skip (dirty)` until someone looks.

Nothing is touched when `HEAD` moved or when anything is staged.

## Rules the script is built around

- **Never `pnpm` in it.** It runs in a bare launchd/cron env where corepack refuses
  the pinned pnpm version; everything goes through
  `node <repo>/node_modules/tsx/dist/cli.mjs` under an explicit node directory.
  The root `package.json` lists `tsx` as a dev dependency so that this path exists
  after `pnpm install` at the repo root.
- **Never `pkill -f daemon.ts`** — it self-matches the shell running it. Kill by
  cmdline match scoped to this repo, excluding shells and the script's own pid,
  and never the process group (a daemon started by another script shares that
  script's group).
- **No flock, on purpose.** launchd/cron never overlap one job, and a lock fd
  inherited by the long-lived daemon would make every later pass skip forever.
- **The wrapper must not inherit anything from a pass**: daemon and UI are
  `nohup`'d with every fd redirected. `nohup` + `disown` does not reparent — a
  service the pass just launched stays that shell's child until the shell exits,
  which is why the installer's orphan cleanup skips mesh services when it ends a
  stuck pass.

## Reading it

```bash
tail ~/.agent-mesh/supervisor.log            # daemon: / ui: lines per pass, plus sync: with sync on
launchctl print gui/$(id -u)/local.agent-mesh.supervisor | grep 'last exit'
ps -eo pid=,etime=,command= | grep -E 'agent-mesh/supervisor.sh|git (fetch|merge)' | grep -v grep
```

Sparse timestamps overnight are normal — launchd interval timers do not fire
during sleep — and a `sync: fetch failed` right after a wake is the network
coming up. A `supervisor.sh` or `git fetch`/`git merge` process with an `etime`
in the tens of minutes is the wedge; the deadlines above should make it
impossible, and the installer refuses to reinstall over one.
