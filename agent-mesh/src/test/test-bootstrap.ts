// lib/mesh-bootstrap.sh's broker-URL resolution: the environment wins, then an
// optional site hook named by AGENT_MESH_SITE_HOOK. No network is needed.
//
//   tsx src/test/test-bootstrap.ts

import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const BOOTSTRAP = join(__dirname, "..", "..", "lib", "mesh-bootstrap.sh")

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++
  }
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
}

type Resolved = { status: number | null; url: string; stderr: string }

function resolveUrl(env: Record<string, string | undefined>): Resolved {
  const res = spawnSync("bash", ["-c", 'set -euo pipefail; source "$1"; resolve_mesh_url; printf "%s" "$AGENT_MESH_REDIS_URL"', "mesh-test", BOOTSTRAP], {
    env: { ...process.env, AGENT_MESH_REDIS_URL: undefined, AGENT_MESH_SITE_HOOK: undefined, AWS_PROFILE: undefined, ...env },
    encoding: "utf8",
  })
  return { status: res.status, url: res.stdout, stderr: res.stderr }
}

export function runBootstrapTest(): number {
  console.log(`\n== mesh-bootstrap broker URL resolution ==`)
  failures = 0
  const dir = mkdtempSync(join(tmpdir(), "agent-mesh-bootstrap-"))
  try {
    const marker = join(dir, "hook-ran")
    const hook = join(dir, "site-hook.sh")
    writeFileSync(hook, `mesh_site_resolve_redis_url() { touch "${marker}"; printf '%s\\n' "redis://from-hook:6379"; }\n`)

    const fromEnv = resolveUrl({ AGENT_MESH_REDIS_URL: "redis://from-env:6379", AGENT_MESH_SITE_HOOK: hook })
    check("an AGENT_MESH_REDIS_URL in the environment wins", fromEnv.status === 0 && fromEnv.url === "redis://from-env:6379", fromEnv.stderr)
    check("the site hook is not consulted when the environment has a URL", !existsSync(marker))

    const fromHook = resolveUrl({ AGENT_MESH_SITE_HOOK: hook })
    check("AGENT_MESH_SITE_HOOK supplies the URL when the environment has none", fromHook.status === 0 && fromHook.url === "redis://from-hook:6379", fromHook.stderr)

    const none = resolveUrl({ AGENT_MESH_SITE_HOOK: join(dir, "no-such-hook.sh") })
    check("no URL and no hook fails with a hint", none.status === 1 && none.stderr.includes("AGENT_MESH_REDIS_URL is not set"), `${none.status} ${none.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(`\nbootstrap: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}

if (process.argv[1]?.endsWith("test-bootstrap.ts")) process.exitCode = runBootstrapTest() > 0 ? 1 : 0
