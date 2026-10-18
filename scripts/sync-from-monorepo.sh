#!/usr/bin/env bash
# Copy the agent-mesh package from the private monorepo into this repo.
#
#   scripts/sync-from-monorepo.sh <monorepo-path> <git-ref>
#   scripts/sync-from-monorepo.sh --refresh-patch <monorepo-path> [<git-ref>]
#
# What a sync does, in order:
#   1. exports <monorepo>/agent-mesh at <git-ref> into a temp dir (git archive; the
#      monorepo's working tree and branches are never touched),
#   2. drops the paths that are not part of the public package (EXCLUDE) and the
#      files this repo maintains by hand (HAND_MAINTAINED),
#   3. applies the scrub rules in scripts/sync/scrub.pl,
#   4. merges package.json files, keeping this repo's name/private/license,
#   5. applies scripts/sync/local.patch: the changes this repo makes to agent-mesh/
#      that the monorepo does not have (the mesh console). It STOPS if the patch
#      no longer applies,
#   6. runs the denylist gate on the staged copy and STOPS if it finds anything,
#   7. mirrors the staged copy into ./agent-mesh (files deleted upstream are
#      deleted here; hand-maintained files and local build output are kept),
#   8. runs the denylist gate on the whole repo, and
#   9. refreshes pnpm-lock.yaml and agent-mesh/dashboard/pnpm-lock.yaml when
#      dependencies changed.
#
# Nothing is committed. Review `git diff`, run the checks, then commit.
#
# --refresh-patch rewrites scripts/sync/local.patch from the working tree: it
# stages upstream at <git-ref> (default: the commit in scripts/sync/last-sync.txt)
# with steps 1-4, and diffs that against ./agent-mesh. Run it after every commit
# that changes agent-mesh/ here, and commit the patch with the change.
# NIGHTWATCH_SKIP_LOCAL_PATCH=1 syncs upstream alone, for when the patch stops
# applying (docs/MAINTAINING.md has the steps).
#
# The denylist is read from $NIGHTWATCH_DENYLIST, default
# scripts/sync/denylist.local.txt (gitignored). The script refuses to run without
# it. See scripts/sync/denylist.example.txt for the format.
set -euo pipefail

die() { echo "sync: $*" >&2; exit 1; }

MODE=sync
if [[ "${1:-}" == "--refresh-patch" ]]; then
  MODE=refresh-patch
  shift
  [[ $# -eq 1 || $# -eq 2 ]] || die "usage: scripts/sync-from-monorepo.sh --refresh-patch <monorepo-path> [<git-ref>]"
else
  [[ $# -eq 2 ]] || die "usage: scripts/sync-from-monorepo.sh <monorepo-path> <git-ref>"
fi
MONO="$1"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LAST_FILE="$HERE/scripts/sync/last-sync.txt"
PATCH="$HERE/scripts/sync/local.patch"
REF="${2:-$(sed -n 's/^commit //p' "$LAST_FILE" 2>/dev/null || true)}"
[[ -n "$REF" ]] || die "no <git-ref> given and none recorded in scripts/sync/last-sync.txt"
DENYLIST="${NIGHTWATCH_DENYLIST:-$HERE/scripts/sync/denylist.local.txt}"
GATE="$HERE/scripts/sync/denylist-gate.pl"

[[ -f "$DENYLIST" ]] || die "no denylist at $DENYLIST (set NIGHTWATCH_DENYLIST; see scripts/sync/denylist.example.txt)"
git -C "$MONO" rev-parse --git-dir >/dev/null 2>&1 || die "$MONO is not a git repository"
SHA="$(git -C "$MONO" rev-parse --verify --quiet "$REF^{commit}")" || die "unknown ref $REF in $MONO"
command -v node >/dev/null || die "node is required"
command -v rsync >/dev/null || die "rsync is required"

if [[ "$MODE" == sync && -n "$(git -C "$HERE" status --porcelain -- agent-mesh scripts/sync/local.patch)" ]]; then
  die "agent-mesh/ or scripts/sync/local.patch has uncommitted changes here; commit or stash them first"
fi

# Paths under the monorepo's agent-mesh/ that are not part of the public package.
EXCLUDE=(
  agent-mesh/agents          # an internal example agent, not part of the package
  agent-mesh/remote          # chat relay; removed upstream, never shipped here
  agent-mesh/deploy          # internal deployment manifests
  agent-mesh/docs            # docs are hand-maintained under ./docs
  agent-mesh/start-reviewer.sh # launcher for the monorepo app's reviewer overlay
  'agent-mesh/lib/*-hook.sh' # site hooks: deployment-specific broker lookup
  agent-mesh/pnpm-workspace.yaml # here agent-mesh is a package of the root workspace
  agent-mesh/pnpm-lock.yaml      # ...and the root pnpm-lock.yaml covers it
)
# Files this repo maintains by hand. A sync never overwrites or deletes them.
HAND_MAINTAINED=(
  agent-mesh/README.md
  agent-mesh/.env.example
  agent-mesh/dashboard/pnpm-lock.yaml # regenerated here, because local.patch adds dependencies
)
# Files this repo keeps when the ref does not have them yet.
KEEP_IF_ABSENT=(
  agent-mesh/verify.sh
)
# Never mirrored, never part of local.patch: build output, generated code, secrets.
LOCAL_ONLY=(
  'node_modules/' '/dist/' '/dashboard/dist/' '/src/generated/' '*.tsbuildinfo' '/.env' '/.env.local'
)

STAGE="$(mktemp -d -t nightwatch-sync-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
# git diff --no-index and git apply below must treat the stage as a plain
# directory, even when the temp dir happens to sit inside a git checkout.
NOGIT=(env GIT_CEILING_DIRECTORIES="$(dirname "$STAGE")")

echo "sync: exporting agent-mesh at ${SHA:0:10}"
git -C "$MONO" archive "$SHA" agent-mesh | tar -x -C "$STAGE"
[[ -d "$STAGE/agent-mesh/src" ]] || die "ref has no agent-mesh/src"

# EXCLUDE entries may be globs; expand them inside the stage only.
shopt -s nullglob
for path in "${EXCLUDE[@]}" "${HAND_MAINTAINED[@]}"; do
  # shellcheck disable=SC2086 # intentional glob expansion
  for match in "${STAGE:?}"/$path; do rm -rf "$match"; done
done
shopt -u nullglob
for path in "${KEEP_IF_ABSENT[@]}"; do
  if [[ ! -e "$STAGE/$path" && -e "$HERE/$path" ]]; then
    cp -p "$HERE/$path" "$STAGE/$path"
    echo "sync: kept this repo's $path (not at the ref)"
  fi
done

echo "sync: applying scrub rules"
perl "$HERE/scripts/sync/scrub.pl" "$STAGE"

node "$HERE/scripts/sync/merge-package-json.mjs" \
  "$STAGE/agent-mesh/package.json" "$HERE/agent-mesh/package.json" \
  '{"name":"agent-mesh","private":true,"license":"MIT","scripts":{"verify":"./verify.sh"}}'
if [[ -f "$STAGE/agent-mesh/dashboard/package.json" ]]; then
  node "$HERE/scripts/sync/merge-package-json.mjs" \
    "$STAGE/agent-mesh/dashboard/package.json" "$HERE/agent-mesh/dashboard/package.json" \
    '{"name":"agent-mesh-dashboard","private":true,"license":"MIT"}'
fi

rsync_excludes=(--exclude '/README.md' --exclude '/.env.example' --exclude '/dashboard/pnpm-lock.yaml')
for path in "${LOCAL_ONLY[@]}"; do rsync_excludes+=(--exclude "$path"); done

if [[ "$MODE" == refresh-patch ]]; then
  # Diff upstream (staged) against this repo's agent-mesh/, both under the same
  # relative path so the patch applies with -p1 inside a stage.
  mkdir -p "$STAGE/here"
  rsync -a "${rsync_excludes[@]}" "$HERE/agent-mesh/" "$STAGE/here/agent-mesh/"
  (cd "$STAGE" && "${NOGIT[@]}" git diff --no-index --binary --src-prefix=a/ --dst-prefix=b/ agent-mesh here/agent-mesh || true) |
    sed -E '/^(diff --git|---|\+\+\+|rename (from|to)|copy (from|to)) /s#([ab])/here/agent-mesh/#\1/agent-mesh/#g' > "$STAGE/local.patch"
  if [[ -s "$STAGE/local.patch" ]]; then
    cp "$STAGE/local.patch" "$PATCH"
    echo "sync: wrote scripts/sync/local.patch against ${SHA:0:10}:"
    git apply --stat "$PATCH" | tail -1 | sed 's/^/  /'
  else
    rm -f "$PATCH"
    echo "sync: agent-mesh/ matches upstream at ${SHA:0:10}; removed scripts/sync/local.patch"
  fi
  exit 0
fi

if [[ -f "$PATCH" && "${NIGHTWATCH_SKIP_LOCAL_PATCH:-}" == 1 ]]; then
  echo "sync: NIGHTWATCH_SKIP_LOCAL_PATCH=1: not applying scripts/sync/local.patch (upstream only)"
elif [[ -f "$PATCH" ]]; then
  echo "sync: applying scripts/sync/local.patch"
  # Outside a git repository, git apply behaves like patch(1).
  (cd "$STAGE" && "${NOGIT[@]}" git apply --whitespace=nowarn "$PATCH") ||
    die "scripts/sync/local.patch does not apply at ${SHA:0:10}. Port the conflicting upstream change by hand: see docs/MAINTAINING.md"
fi

echo "sync: denylist gate on the staged copy"
if ! perl "$GATE" --denylist "$DENYLIST" --tree "$STAGE"; then
  die "refusing to sync: the staged copy has denylisted content. Add a rule to scripts/sync/scrub.pl and re-run."
fi

deps_of() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log(JSON.stringify([p.dependencies??null,p.devDependencies??null]))})'; }
old_deps="$( (git -C "$HERE" show HEAD:agent-mesh/package.json 2>/dev/null || echo '{}') | deps_of)"
old_ui_deps="$( (git -C "$HERE" show HEAD:agent-mesh/dashboard/package.json 2>/dev/null || echo '{}') | deps_of)"
new_files="$(cd "$STAGE" && find agent-mesh -type f | sort | while read -r f; do [[ -e "$HERE/$f" ]] || echo "$f"; done)"

# The mirror is scoped to agent-mesh/. Everything outside it (reviewer-overlay/,
# skills/, docs/) is maintained by hand in this repo and has no upstream copy, so
# widening the rsync target to the repo root would delete it.
mkdir -p "$HERE/agent-mesh"
rsync -a --delete "${rsync_excludes[@]}" "$STAGE/agent-mesh/" "$HERE/agent-mesh/"

echo "sync: denylist gate on the whole repo"
perl "$GATE" --denylist "$DENYLIST" --tree "$HERE" || die "the repo has denylisted content after the sync; fix it before committing"

refresh_lockfile() { # <dir relative to the repo root> <label>
  if command -v pnpm >/dev/null; then
    echo "sync: $2 dependencies changed; refreshing $1/pnpm-lock.yaml"
    (cd "$HERE/$1" && pnpm install --lockfile-only)
  else
    echo "sync: $2 dependencies changed; run 'pnpm install --lockfile-only' in $1" >&2
  fi
}
[[ "$old_deps" == "$(deps_of < "$HERE/agent-mesh/package.json")" ]] || refresh_lockfile . agent-mesh
if [[ -f "$HERE/agent-mesh/dashboard/package.json" && "$old_ui_deps" != "$(deps_of < "$HERE/agent-mesh/dashboard/package.json")" ]]; then
  refresh_lockfile agent-mesh/dashboard dashboard
fi

previous="$(sed -n 's/^commit //p' "$LAST_FILE" 2>/dev/null || true)"
printf 'commit %s\n' "$SHA" > "$LAST_FILE"

echo
echo "sync: done (${SHA:0:10}). Changed files:"
git -C "$HERE" status --short -- agent-mesh scripts/sync/last-sync.txt pnpm-lock.yaml | sed 's/^/  /'
if [[ -n "$new_files" ]]; then
  echo "sync: files that are new in this repo (read them before committing):"
  echo "$new_files" | sed 's/^/  /'
fi
if [[ -n "$previous" && "$previous" != "$SHA" ]] && git -C "$MONO" cat-file -e "$previous^{commit}" 2>/dev/null; then
  echo "sync: upstream sources of hand-maintained files changed since ${previous:0:10}:"
  git -C "$MONO" diff --stat "$previous" "$SHA" -- \
    agent-mesh/README.md docs/agent-mesh .claude/skills/nightwatch .claude/skills/agent-mesh \
    .claude/skills/plan-review .claude/skills/human-review | sed 's/^/  /'
  echo "  Port any substance by hand into README.md, docs/ and skills/ with the same scrub rules."
fi
echo
echo "next: pnpm install && pnpm typecheck && pnpm test && ./agent-mesh/verify.sh, then commit."
