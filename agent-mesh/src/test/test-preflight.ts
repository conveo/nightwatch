// preflight.sh is the nightwatch Phase 4 delivery gate. It is run against a fake
// `agent-mesh` (first on the script's PATH via HOME/.local/bin) that prints a
// canned `delivery` status, so the gate's verdicts are checked without a daemon.
//
//   tsx src/test/test-preflight.ts

import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PREFLIGHT = join(__dirname, "..", "..", "preflight.sh")

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++
  }
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
}

function readyStatus(overrides: { receiptAgoMs: number; tickReady: boolean }) {
  return {
    owns: true,
    automaticWakeup: true,
    receiptConfirmed: true,
    targetVerification: { reason: "verified-dedicated-agent" },
    state: { lastReceipt: { at: Date.now() - overrides.receiptAgoMs }, batch: null },
    tickReady: overrides.tickReady,
  }
}

export function runPreflightTest(): number {
  console.log(`\n== preflight.sh delivery gate ==`)
  failures = 0
  const home = mkdtempSync(join(tmpdir(), "agent-mesh-preflight-"))
  try {
    const bin = join(home, ".local", "bin")
    mkdirSync(bin, { recursive: true })
    const statusFile = join(home, "status.json")
    const argsFile = join(home, "args")
    writeFileSync(join(bin, "agent-mesh"), `#!/bin/sh\necho "$@" > "${argsFile}"\ncat "${statusFile}"\n`)
    chmodSync(join(bin, "agent-mesh"), 0o755)
    const run = (status: object, env: Record<string, string>) => {
      writeFileSync(statusFile, JSON.stringify(status))
      return spawnSync("bash", [PREFLIGHT], {
        env: { ...process.env, HOME: home, AGENT_MESH_ID: undefined, MESH_REQUIRE_TICK: undefined, REMOTE_ORCHESTRATOR_ID: undefined, SCOPE: undefined, REMOTE_BACKEND: undefined, ...env },
        encoding: "utf8",
      })
    }

    const ready = run(readyStatus({ receiptAgoMs: 30_000, tickReady: true }), { AGENT_MESH_ID: "nw-x-orchestrator" })
    check("a verified, recently receipted, ticked actor passes", ready.status === 0, ready.stderr)
    check("AGENT_MESH_ID selects the actor whose delivery is read", readFileSync(argsFile, "utf8").trim() === "delivery --id nw-x-orchestrator")
    const stale = run(readyStatus({ receiptAgoMs: 10 * 60_000, tickReady: true }), {})
    check("a receipt older than five minutes fails", stale.status === 1 && stale.stderr.includes("NOT READY"))
    const noTick = run(readyStatus({ receiptAgoMs: 30_000, tickReady: false }), {})
    check("an orchestrator without a received tick fails", noTick.status === 1 && noTick.stderr.includes("tick"))
    const worker = run(readyStatus({ receiptAgoMs: 30_000, tickReady: false }), { MESH_REQUIRE_TICK: "0" })
    check("MESH_REQUIRE_TICK=0 lets a non-orchestrator pass without a tick", worker.status === 0, worker.stderr)
    const obsolete = run(readyStatus({ receiptAgoMs: 30_000, tickReady: true }), { REMOTE_ORCHESTRATOR_ID: "remote.orchestrator", SCOPE: "proj1" })
    check(
      "the old remote-side inputs are reported as not checked",
      obsolete.status === 0 && obsolete.stderr.includes("REMOTE_ORCHESTRATOR_ID is not read") && obsolete.stderr.includes("SCOPE is not read"),
      obsolete.stderr,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  console.log(`\npreflight: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}

if (process.argv[1]?.endsWith("test-preflight.ts")) process.exitCode = runPreflightTest() > 0 ? 1 : 0
