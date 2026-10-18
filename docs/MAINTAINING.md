# Maintaining this repository

The `agent-mesh/` code is developed in a private monorepo. This repo receives it
through `scripts/sync-from-monorepo.sh`. Everything else here (README files, `docs/`,
`skills/`, `reviewer-overlay/`, `LICENSE`, `SECURITY.md`, CI) is maintained by hand
in this repo. A sync writes only `agent-mesh/`, `scripts/sync/last-sync.txt` and
the two lockfiles.

`agent-mesh/` here is the monorepo's copy plus changes that exist only in this repo
(the mesh console). Those changes are kept as one patch, `scripts/sync/local.patch`,
which every sync applies on top of the upstream copy.

## Sync the code

```bash
scripts/sync-from-monorepo.sh <path-to-monorepo> <git-ref>
git diff
pnpm install && pnpm typecheck && AGENT_MESH_REDIS_URL=redis://127.0.0.1:6379 pnpm test
./agent-mesh/verify.sh
git add -A && git commit
```

The script:

1. exports `agent-mesh/` at the ref with `git archive`. It never checks out,
   commits or edits anything in the monorepo;
2. drops the paths that are not part of the public package (`EXCLUDE` in the
   script) and the hand-maintained files (`HAND_MAINTAINED`);
3. applies the scrub rules in `scripts/sync/scrub.pl`;
4. merges `package.json`: `name`, `private` and `license` keep this repo's values;
5. applies `scripts/sync/local.patch`, and stops without touching this repo if the
   patch no longer applies;
6. runs the denylist gate on the staged copy, and stops without touching this repo
   if it finds anything;
7. mirrors the staged copy into `agent-mesh/`. Files deleted upstream are deleted
   here. Hand-maintained files, `node_modules`, `dist`, the generated Prisma client
   and `.env` are kept;
8. runs the denylist gate on the whole repo;
9. refreshes `pnpm-lock.yaml` and `agent-mesh/dashboard/pnpm-lock.yaml` when their
   dependencies changed, and records the synced commit in
   `scripts/sync/last-sync.txt`.

It prints the files that are new in this repo, and the upstream sources of
hand-maintained files (`docs/agent-mesh/`, the skills) that changed since the last
sync. Port those changes by hand, with the same scrub rules.

`agent-mesh/verify.sh` is kept from this repo while the monorepo has no copy
(`KEEP_IF_ABSENT`). Once the monorepo has one, the sync takes it from there.

`agent-mesh/pnpm-workspace.yaml` and `agent-mesh/pnpm-lock.yaml` are never copied:
here `agent-mesh` is a package of the root workspace, so the root
`pnpm-workspace.yaml` and `pnpm-lock.yaml` cover it. The dashboard lockfile is
maintained here and regenerated, because `local.patch` adds dashboard dependencies.

## Change agent-mesh/ in this repo

Edit `agent-mesh/` as usual, commit, then rewrite the patch and commit it with the
change:

```bash
scripts/sync-from-monorepo.sh --refresh-patch <path-to-monorepo>
git add scripts/sync/local.patch && git commit --amend --no-edit
```

Do not use the patch to remove private or internal text from an upstream file. A
patch records both sides, so its removed lines would publish the original text.
Add a rule to `scripts/sync/scrub.pl` instead, so the staged upstream copy is
already clean, then refresh the patch.

`--refresh-patch` stages upstream at the commit in `scripts/sync/last-sync.txt`
(steps 1–4 above) and diffs it against `agent-mesh/`. A sync refuses to run while
`agent-mesh/` or the patch has uncommitted changes, so the two cannot drift.

When a sync stops because the patch no longer applies, an upstream change touched
the same lines. Sync upstream on its own, re-apply the patch with a three-way merge,
resolve the conflicts, then refresh the patch:

```bash
NIGHTWATCH_SKIP_LOCAL_PATCH=1 scripts/sync-from-monorepo.sh <path-to-monorepo> <new-ref>
git apply --3way scripts/sync/local.patch   # resolve the conflicts it reports
scripts/sync-from-monorepo.sh --refresh-patch <path-to-monorepo>
```

## The denylist

The gate (`scripts/sync/denylist-gate.pl`) reads a denylist of private strings:
people, hosts, account ids, customer names, internal URLs and token shapes. The
real list is not committed, because publishing it would publish its contents. Keep
it at `scripts/sync/denylist.local.txt` (gitignored) or point
`NIGHTWATCH_DENYLIST` at it. The format is in `scripts/sync/denylist.example.txt`.

Run the gate by hand over the tree and over every commit:

```bash
perl scripts/sync/denylist-gate.pl --denylist scripts/sync/denylist.local.txt --tree .
perl scripts/sync/denylist-gate.pl --denylist scripts/sync/denylist.local.txt --history . --show-allowed
```

When the gate stops a sync, add or widen a rule in `scrub.pl`. Rules match by
structure (a function name, a comment shape, a file path) rather than by quoting the
private text, so `scrub.pl` itself can stay public. Do not remove entries from the
denylist to make a sync pass.

## Rename the package

The package names live in one place each: `"name"` in `package.json` (repo root),
`agent-mesh/package.json`, `agent-mesh/dashboard/package.json` and
`reviewer-overlay/package.json`. A sync keeps whatever these files say, and never
reads or writes `reviewer-overlay/`.
