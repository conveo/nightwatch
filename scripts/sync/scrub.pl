#!/usr/bin/env perl
# Scrub transforms applied to every file that scripts/sync-from-monorepo.sh copies
# from the monorepo. Usage:
#
#   perl scripts/sync/scrub.pl <stage-root>
#
# <stage-root> holds the copied tree with repo-relative paths (agent-mesh/...).
# Files are rewritten in place. Binary files (any NUL byte) are left alone.
# Prints one line per rule that changed a file.
#
# The rules match by structure, not by quoting the private text they remove, so
# this file can be published. The denylist gate (denylist-gate.pl) runs after
# these rules and fails the sync if anything private is left. When the gate
# fails, add or widen a rule here; do not weaken the denylist.
use strict;
use warnings;
use File::Find;

my $root = shift @ARGV or die "usage: scrub.pl <stage-root>\n";
$root =~ s{/+$}{};

# Each rule: [ name, path regex (repo-relative), code that edits $_ ].
my @rules = (
  # ---- global ---------------------------------------------------------------
  # Docs live at the repo root in this repo, not under docs/agent-mesh/.
  [ 'docs-path', qr{.}, sub { s{docs/agent-mesh/}{docs/}g } ],
  [ 'verification-doc-name', qr{.}, sub { s{SUPERSET-VERIFICATION\.md}{VERIFICATION.md}g } ],

  # Internal tracker keys in comments. Remove the reference and keep the sentence.
  [ 'tracker-ref-in-comment', qr{.}, sub {
      s{\s*\(CON-\d+ finding \d+\)}{}g;
      s{\(CON-\d+ — }{(}g;
      s{\(CON-\d+: }{(}g;
      s{, see CON-\d+\)}{)}g;
      s{ — CON-\d+\)}{)}g;
      s{\s*\((?:see )?CON-\d+\)}{}g;
      s{(\w+) \(CON-\d+ drift\)}{$1 drift}g;
      s{\(CON-\d+ ([^)]*)\)}{($1)}g;
      s{(//\s*)CON-\d+'s (\w)}{${1}The $2}g;
      s{(//\s*)CON-\d+: (\w)}{$1\u$2}g;
    } ],
  # Any key left is test data or an example; give it a neutral project key.
  [ 'tracker-key-fallback', qr{.}, sub { s{\bCON-(\d+)}{PROJ-$1}g; s{\bcon-(\d+)}{proj-$1}g } ],

  # The monorepo's per-worktree Redis port; the public default is Redis's own.
  [ 'redis-port', qr{.}, sub { s{redis://localhost:6386}{redis://localhost:6379}g } ],

  # The monorepo keeps plans in a dot-directory that does not exist here.
  [ 'plans-dir', qr{.}, sub { s{\.notes/plans/}{plans/}g } ],

  # The monorepo's reviewer launcher is app-specific and is not shipped.
  [ 'reviewer-launcher', qr{.}, sub {
      s{\(start-local\.sh, start-reviewer\.sh\)}{(start-local.sh, and any launcher you write)}g;
      s{\(e\.g\. start-reviewer\.sh\)}{(e.g. a reviewer launcher)}g;
      s{start-reviewer\.sh}{a reviewer launcher}g;
    } ],

  # ---- per file -------------------------------------------------------------
  [ 'claude-delivery-findings', qr{^agent-mesh/src/claude-delivery\.ts$}, sub {
      s{\(claude CLI 2\.1\.x — see docs/(?:agent-mesh/)?PROGRESS\.md for the full writeup\)}{(claude CLI 2.1.x behaviour the resume transport relies on)}g;
    } ],
  [ 'supervisor-label', qr{^agent-mesh/lib/install-supervisor\.sh$}, sub {
      s{^LABEL=\S+$}{LABEL=local.agent-mesh.supervisor}mg;
      s{^(\s*resolve_mesh_url) # .*$}{$1 # AGENT_MESH_REDIS_URL, else the script named by AGENT_MESH_SITE_HOOK}mg;
    } ],
  [ 'bootstrap-broker-resolution', qr{^agent-mesh/lib/mesh-bootstrap\.sh$}, sub {
      # A hard-coded broker endpoint and the comment block directly above it.
      s{(?:^#[^\n]*\n)*^[A-Za-z_]+="?rediss?://[^\n]*\n\n?}{}mg;
      if (/mesh_site_resolve_redis_url/) {
        # Hook-based resolver: keep it, but with no default site hook. The
        # monorepo's own hook file is excluded from the sync (see EXCLUDE).
        s{\$\{AGENT_MESH_SITE_HOOK:-\$_MESH_LIB_DIR/[\w.-]+\.sh\}}{\${AGENT_MESH_SITE_HOOK:-}}g;
        s{the file named by AGENT_MESH_SITE_HOOK, else lib/[\w.-]+\.sh when it\n# exists\.}{the file named by AGENT_MESH_SITE_HOOK, when it\n# exists.}g;
      } else {
        # Resolver with the lookup inlined: replace it and its comment block with
        # the env-only version. Deployments override it in their launcher.
        s{(?:^#[^\n]*\n)*^resolve_mesh_url\(\) \{\n.*?^\}\n}{resolve_mesh_url_generic()}mse;
      }
      s{from bin/create-worktree\.sh \(a sibling of the repo\)}{from `git worktree add` (often a sibling of the repo)}g;
    } ],
  # The bootstrap test also exercises the monorepo's own site hook, which is not
  # shipped. Keep the generic checks (env wins, AGENT_MESH_SITE_HOOK, no hook).
  [ 'bootstrap-test-site-hook', qr{^agent-mesh/src/test/test-bootstrap\.ts$}, sub {
      s{ optional site hook \(lib/[\w.-]+\.sh by default\)\. The \w+ hook is run\n// against a fake `aws` on PATH, so neither AWS nor a network is needed\.}{ optional site hook named by AGENT_MESH_SITE_HOOK. No network is needed.}g;
      s{\n\n    // The default hook is the [^\n]*\n.*?(?=\n  \} finally \{)}{}s;
    } ],
  # An example sender id in the CLI output-escaping test.
  [ 'cli-test-example-id', qr{^agent-mesh/src/test/test-cli\.ts$}, sub {
      s{(\d-0  )[a-z]+\.laptop( -> request)}{${1}someone.laptop$2}g;
    } ],
  [ 'start-local-header', qr{^agent-mesh/start-local\.sh$}, sub {
      s{\A(#![^\n]*\n)(?:#[^\n]*\n)+(?=set -euo pipefail)}{$1 . start_local_header()}e;
      s{^(\s*resolve_mesh_url)\s+# .*$}{$1   # AGENT_MESH_REDIS_URL, else the script named by AGENT_MESH_SITE_HOOK}mg;
      s{echo "mode: DEV mesh}{echo "mode: shared mesh}g;
    } ],
  [ 'teardown-containers', qr{^agent-mesh/teardown\.sh$}, sub {
      s{grep -E '[a-z0-9]+-wt\|agent-mesh-test'}{grep -E "\${AGENT_MESH_TEARDOWN_CONTAINERS:-agent-mesh-test}"}g;
    } ],
  [ 'test-home-path', qr{^agent-mesh/src/test/}, sub { s{/Users/[^/\s"'`]+/}{/Users/dev/}g } ],
  # Comments and fixtures that describe the monorepo's own infrastructure, runs and
  # tickets. Rewritten here rather than in local.patch, whose removed lines would
  # otherwise publish the original text.
  [ 'daemon-host-comments', qr{^agent-mesh/src/daemon\.ts$}, sub {
      s{(// The agent-mesh daemon — one per host) \([^)\n]*\)\.}{$1 (a laptop or a remote box).};
      s{\(matters for the \w+ skill-bootstrap where multiple\n  // agents may race to start it\)}{(matters for a bootstrap where several agents may race\n  // to start it)};
    } ],
  [ 'redis-broker-comment', qr{^agent-mesh/src/redis\.ts$}, sub {
      s{Reads AGENT_MESH_REDIS_URL \(the shared\n// cross-host broker on the \w+ cluster\), falling back to REDIS_URL for local\n// single-host testing\.}{Reads AGENT_MESH_REDIS_URL (the broker\n// every host shares), falling back to REDIS_URL for local single-host testing.};
    } ],
  [ 'dockerfile-header', qr{^agent-mesh/Dockerfile$}, sub {
      s{\A(?:#[^\n]*\n)+(?=FROM )}{# Optional container image that runs the daemon as a standalone service. The\n# dashboard and the console are not in it; run `pnpm ui` from a checkout for those.\n};
    } ],
  [ 'supervisor-owner-name', qr{^agent-mesh/supervisor\.sh$}, sub {
      s{the host's `\*\.\w+` orchestrator owns it}{the host's orchestrator owns it}g;
      s{so the host's \w+ re-arms after}{so the host's orchestrator re-arms after}g;
    } ],
  [ 'test-fixture-names', qr{^agent-mesh/src/test/test-(delivery|managed|preflight|cli|plan-render)\.ts$}, sub {
      s{`sess-[a-z]+\d+-\$\{process\.pid\}`}{`sess-resume-\${process.pid}`}g;
      s{"nw-[a-z0-9]+-helm",}{"session-name",}g;
      s{REMOTE_ORCHESTRATOR_ID: "remote\.\w+", SCOPE: "\w+"}{REMOTE_ORCHESTRATOR_ID: "remote.orchestrator", SCOPE: "proj1"}g;
      s{not by its path: bin/create-worktree\.sh\n(\s*)// puts them beside the repo}{not by its path: `git worktree add ../x`\n$1// puts one beside the repo}g;
      s{\(the monorepo root provides it\)}{(a devDependency of agent-mesh)}g;
    } ],
  # The logger comment compares itself to a monorepo package that is not shipped.
  [ 'logger-sibling-package', qr{^agent-mesh/src/log\.ts$}, sub {
      s{daemon/CLI\. Mirrors [\w-]+'s\n// approach \(timestamped console\) but emits a single JSON line per record so the\n}{daemon/CLI. It emits a single\n// timestamped JSON line per record so the\n}g;
    } ],
);

sub resolve_mesh_url_generic {
  return <<'EOS';
# Require AGENT_MESH_REDIS_URL. This repo never resolves a broker for you: how the
# URL reaches a host is deployment-specific. To read it from a secrets store,
# define your own resolve_mesh_url after sourcing this file.
resolve_mesh_url() {
  if [[ -n "${AGENT_MESH_REDIS_URL:-}" ]]; then
    return 0
  fi
  echo "AGENT_MESH_REDIS_URL is not set. Point it at your Redis broker, e.g.:" >&2
  echo "  export AGENT_MESH_REDIS_URL=redis://localhost:6379" >&2
  return 1
}
EOS
}

sub start_local_header {
  return <<'EOS';
# Start a per-host agent-mesh daemon and join a mesh. Run it in its own terminal;
# Ctrl-C stops it.
#
#   AGENT_MESH_REDIS_URL=redis://my-broker:6379 ./agent-mesh/start-local.sh   # join a shared mesh
#   ./agent-mesh/start-local.sh --local                                     # localhost:6379
#
# Override anything via env:
#   AGENT_MESH_REDIS_URL  — broker URL (required unless --local)
#   AGENT_MESH_ID         — your agent id        (default: "<you>-laptop")
#   AGENT_MESH_HOSTNAME   — host label in roster (default: $(hostname))
EOS
}

my @files;
find({ no_chdir => 1, wanted => sub { push @files, $File::Find::name if -f $_ } }, $root);

for my $abs (sort @files) {
  (my $rel = $abs) =~ s{^\Q$root\E/}{};
  open my $in, '<:raw', $abs or die "read $abs: $!\n";
  local $/;
  my $orig = <$in>;
  close $in;
  next if $orig =~ /\x00/;    # binary
  my $text = $orig;
  for my $rule (@rules) {
    my ($name, $path_re, $code) = @$rule;
    next unless $rel =~ $path_re;
    my $before = $text;
    { local $_ = $text; $code->(); $text = $_; }
    print "  scrub: $name -> $rel\n" if $text ne $before;
  }
  next if $text eq $orig;
  open my $out, '>:raw', $abs or die "write $abs: $!\n";
  print {$out} $text;
  close $out;
}
