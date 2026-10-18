// Test runner: runs all agent-mesh substep tests against a real Redis.
//   AGENT_MESH_REDIS_URL=redis://localhost:6379 tsx src/test/run.ts
// Uses a throwaway key prefix so it never collides with real hub traffic.

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSupersetTest } from "./test-superset.js"
import { runInboxStoreTest } from "./test-inbox-store.js"
import { runManagedTest } from "./test-managed.js"
import { runManagedDaemonTest } from "./test-managed-daemon.js"
import { runCoreTest } from "./test-core.js"
import { runCliTest } from "./test-cli.js"
import { runBroadcastCursorTest, runDaemonTest, runHostBroadcastTest, runRestoreValidationTest, runSingletonTest } from "./test-daemon.js"
import { runDeliveryTest } from "./test-delivery.js"
import { runUiServerTest } from "./test-ui-server.js"
import { runPlanRenderTest } from "./test-plan-render.js"
import { runBootstrapTest } from "./test-bootstrap.js"
import { runPreflightTest } from "./test-preflight.js"
import { runLivenessSweepTest } from "./test-liveness.js"
import { runConsoleBoundariesTest } from "./test-console-boundaries.js"
import { runConsoleMigrationsTest } from "./test-console-migrations.js"
import { runDigestTest } from "./test-digest.js"
import { runInboxRoutingTest } from "./test-inbox-routing.js"
import { runReceiptTest } from "./test-receipt.js"
import { runConsoleGuardsTest } from "./test-console-guards.js"
import { runTranscriptMergeTest } from "./test-transcript-merge.js"
import { runTranscriptStoreTest } from "./test-transcript-store.js"
import { runWatchTest } from "./test-watch.js"

process.env.AGENT_MESH_PREFIX = process.env.AGENT_MESH_PREFIX ?? "meshtest"
// Unconditionally a scratch file. The store tests WRITE, and the console database is
// opened lazily on first use, so this must be set before any test touches it — an
// inherited value could be the live console's transcript.
process.env.CONSOLE_DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), "console-store-")), "t.db")}`

async function main() {
  let failures = await runSupersetTest()
  failures += runInboxStoreTest()
  failures += runReceiptTest()
  failures += runConsoleGuardsTest()
  failures += runDigestTest()
  failures += runInboxRoutingTest()
  failures += await runConsoleBoundariesTest()
  failures += await runConsoleMigrationsTest()
  failures += runTranscriptMergeTest()
  failures += await runTranscriptStoreTest()
  failures += await runManagedTest()
  failures += await runManagedDaemonTest()
  failures += await runCoreTest()
  failures += await runDaemonTest()
  failures += await runBroadcastCursorTest()
  failures += await runHostBroadcastTest()
  failures += await runSingletonTest()
  failures += await runRestoreValidationTest()
  failures += await runLivenessSweepTest()
  failures += await runWatchTest()
  failures += await runDeliveryTest()
  failures += await runCliTest()
  failures += await runUiServerTest()
  failures += await runPlanRenderTest()
  failures += runBootstrapTest()
  failures += runPreflightTest()
  console.log(`\n${"=".repeat(40)}\n${failures === 0 ? "✅ ALL SUBSTEPS PASS" : `❌ ${failures} CHECK(S) FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
