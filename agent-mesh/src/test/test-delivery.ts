// Unit tests for the claude-resume delivery path (no Redis needed):
//   - buildResumeArgv carries the scoped --allowedTools grant (a resumed headless
//     turn must be able to run the agent-mesh CLI without a permission stall)
//   - LIVE session  -> resume is SKIPPED (and logged); the inbox is the backbone
//   - DORMANT session -> resumed exactly once, in the REGISTERED cwd
//   - burst of N messages -> at most ONE resume (debounce + single-flight)
//   - no registered cwd -> no resume (never the daemon's cwd)
// The spawn is abstracted behind an injectable runner so all of the above is
// asserted without a real `claude`; a final integration block exercises the
// DEFAULT probe + runner against a fake claude binary and a fake live process.

import { spawn } from "node:child_process"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildResumeArgv,
  createClaudeResumeDeliverer,
  defaultSessionLivenessProbe,
  deliverViaClaudeResume,
  type NudgeArgs,
  type ResumeRunner,
} from "../claude-delivery.js"
import { isClaudeCommandLine } from "../process-utils.js"
import type { MeshMessage } from "../types.js"

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++
  }
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fixtureMessage(n: number): MeshMessage {
  return {
    id: `${n}-0`,
    ts: new Date().toISOString(),
    from: "orchestrator",
    to: "worker-a",
    type: "request",
    body: { n },
    correlationId: null,
    replyTo: null,
    channel: "mesh:inbox:worker-a",
  }
}

function nudge(sessionId: string, n: number, cwd: string | null = "/tmp/agent-cwd"): NudgeArgs {
  return { sessionId, cwd, pid: null, message: fixtureMessage(n) }
}

type CapturedLog = { level: "info" | "warn"; message: string; ctx: Record<string, unknown> }
type RunnerCall = { bin: string; argv: string[]; cwd: string; onSettle: () => void }

function makeHarness(opts: { live: boolean; liveReason?: string }) {
  const logs: CapturedLog[] = []
  const calls: RunnerCall[] = []
  const runner: ResumeRunner = (args) => {
    calls.push(args)
    return { ok: true, detail: "fake spawn" }
  }
  const deliverer = createClaudeResumeDeliverer({
    probe: () => ({ live: opts.live, reason: opts.liveReason ?? (opts.live ? "fake live" : "fake dormant") }),
    runner,
    debounceMs: 25,
    logger: {
      info: (message, ctx) => logs.push({ level: "info", message, ctx: ctx ?? {} }),
      warn: (message, ctx) => logs.push({ level: "warn", message, ctx: ctx ?? {} }),
    },
  })
  return { deliverer, logs, calls }
}

export async function runDeliveryTest(): Promise<number> {
  console.log(`\n== claude-resume delivery (liveness skip + debounce + cwd) ==`)

  const argv = buildResumeArgv("sess-1", fixtureMessage(0))
  check(
    "resume argv grants Bash scoped to the agent-mesh CLI only",
    argv.includes("--allowedTools") && argv.some((a) => a.includes("agent-mesh *")) && !argv.includes("--dangerously-skip-permissions"),
  )

  check(
    "isClaudeCommandLine matches claude binaries, not paths that merely mention claude",
    isClaudeCommandLine("/Users/dev/.local/bin/claude --permission-mode=auto") &&
      isClaudeCommandLine("claude") &&
      isClaudeCommandLine("node /opt/claude --resume x") &&
      !isClaudeCommandLine("/bin/zsh -c source /Users/dev/.claude/shell-snapshots/snap.sh") &&
      !isClaudeCommandLine("vim claude-delivery.ts"),
  )

  // -- LIVE session: delivery must NOT spawn, and must say why --
  {
    const h = makeHarness({ live: true, liveReason: "registered claude pid 123 is alive" })
    const res = h.deliverer.deliver(nudge("sess-live", 1))
    check("live: delivery is accepted (inbox is the backbone)", res.ok, res.detail)
    await sleep(80) // past the 25ms debounce — the fire must have probed and skipped
    check("live: NO resume process is spawned", h.calls.length === 0, `spawns=${h.calls.length}`)
    const skip = h.logs.find((l) => l.message.includes("session is live"))
    check("live: skip is logged with the probe's reason", skip != null && skip.ctx.reason === "registered claude pid 123 is alive")

    // a later message re-probes (state must not be stuck after a skip)
    h.deliverer.deliver(nudge("sess-live", 2))
    await sleep(80)
    check("live: later messages re-probe and skip again (no stuck state)", h.calls.length === 0 && h.logs.filter((l) => l.message.includes("session is live")).length === 2)
  }

  // -- DORMANT session: resumed exactly once, in the registered cwd --
  {
    const h = makeHarness({ live: false })
    h.deliverer.deliver(nudge("sess-dormant", 1, "/repo/worktrees/agent-a"))
    await sleep(80)
    check("dormant: exactly one resume fires", h.calls.length === 1, `spawns=${h.calls.length}`)
    check("dormant: resume runs in the REGISTERED cwd", h.calls[0]?.cwd === "/repo/worktrees/agent-a", h.calls[0]?.cwd)
    check("dormant: argv is `--resume <session> -p <nudge>`", h.calls[0]?.argv[0] === "--resume" && h.calls[0]?.argv[1] === "sess-dormant" && h.calls[0]?.argv[3].includes("agent-mesh inbox"))
  }

  // -- burst: N messages inside the debounce window -> ONE resume --
  {
    const h = makeHarness({ live: false })
    for (let n = 1; n <= 5; n++) {
      h.deliverer.deliver(nudge("sess-burst", n))
    }
    await sleep(80)
    check("burst: 5 messages -> exactly 1 resume (debounced)", h.calls.length === 1, `spawns=${h.calls.length}`)

    // messages while the resume is RUNNING coalesce into one trailing fire
    h.deliverer.deliver(nudge("sess-burst", 6))
    const coalesced = h.deliverer.deliver(nudge("sess-burst", 7))
    check("in-flight: deliveries coalesce", coalesced.detail.includes("coalesced"), coalesced.detail)
    h.calls[0].onSettle() // first resume turn ends
    await sleep(80)
    check("in-flight: one trailing resume drains everything since", h.calls.length === 2, `spawns=${h.calls.length}`)
    h.calls[1].onSettle()
    await sleep(40)
    check("settled with nothing pending: no further spawns", h.calls.length === 2)
  }

  // -- no registered cwd: never resume in the daemon's cwd --
  {
    const h = makeHarness({ live: false })
    h.deliverer.deliver(nudge("sess-nocwd", 1, null))
    await sleep(80)
    check("no cwd: resume is refused (not fired in daemon cwd)", h.calls.length === 0, `spawns=${h.calls.length}`)
    check("no cwd: refusal is logged as a warning", h.logs.some((l) => l.level === "warn" && l.message.includes("no cwd registered")))
  }

  // -- sessions are independent --
  {
    const h = makeHarness({ live: false })
    h.deliverer.deliver(nudge("sess-a", 1))
    h.deliverer.deliver(nudge("sess-b", 1))
    await sleep(80)
    check("two sessions debounce independently (one resume each)", h.calls.length === 2 && new Set(h.calls.map((c) => c.argv[1])).size === 2)
  }

  // -- integration: DEFAULT probe + runner, fake claude bin, fake live owner --
  failures += await runDefaultPathIntegration()

  console.log(`\ndelivery: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
  return failures
}

// Exercises deliverViaClaudeResume (the daemon's real instance): a process that
// carries the session id on its argv counts as a live owner (pgrep signal); once
// it dies, the next delivery resumes exactly once, in the registered cwd.
async function runDefaultPathIntegration(): Promise<number> {
  console.log(`\n== claude-resume default probe + runner (integration) ==`)
  let failures = 0
  const check = (name: string, cond: boolean, detail = "") => {
    if (!cond) {
      failures++
    }
    console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail !== "" ? `  — ${detail}` : ""}`)
  }

  const dir = mkdtempSync(join(tmpdir(), "agent-mesh-nudge-"))
  const logFile = join(dir, "invocations.log")
  const fakeBin = join(dir, "fake-claude")
  const agentCwd = join(dir, "agent-cwd")
  mkdirSync(agentCwd)
  writeFileSync(fakeBin, `#!/bin/sh\necho "$PWD" >> "${logFile}"\n`)
  chmodSync(fakeBin, 0o755)
  const sessionId = `sess-resume-${process.pid}`
  const prevBin = process.env.AGENT_MESH_CLAUDE_BIN
  const prevDebounce = process.env.AGENT_MESH_RESUME_DEBOUNCE_MS
  process.env.AGENT_MESH_CLAUDE_BIN = fakeBin
  process.env.AGENT_MESH_RESUME_DEBOUNCE_MS = "50"

  // A fake "live owner": a process whose executable is named `claude` and whose
  // argv carries the session id, exactly like an in-flight `claude --resume <id>`.
  const ownerBin = join(dir, "claude")
  writeFileSync(ownerBin, `#!/bin/sh\nsleep 30\n`)
  chmodSync(ownerBin, 0o755)
  const owner = spawn(ownerBin, ["--resume", sessionId], { stdio: "ignore" })
  // …and a NON-claude process that merely mentions the id (e.g. someone tailing
  // the transcript) — this must NOT count as the session's owner. The compound
  // command stops sh from exec'ing the sleep (which would replace its argv).
  const bystander = spawn("sh", ["-c", `: ${sessionId}; sleep 30`], { stdio: "ignore" })

  try {
    await sleep(100) // let both start so pgrep can see them
    const probed = defaultSessionLivenessProbe({ sessionId, pid: null })
    check("default probe sees the live claude owner via argv (pgrep + ps)", probed.live, probed.reason)
    check("a registered pid that is NOT a claude process does not count as live (pid-reuse guard)", defaultSessionLivenessProbe({ sessionId: "sess-no-such", pid: bystander.pid ?? null }).live === false)

    deliverViaClaudeResume({ sessionId, cwd: agentCwd, pid: null, message: fixtureMessage(1) })
    await sleep(300)
    check("message to a LIVE session: no resume spawned", !existsSync(logFile))

    owner.kill("SIGKILL")
    await sleep(500) // generous: pgrep may see the killed pid briefly on loaded hosts
    check("a NON-claude process mentioning the id does not keep the session live", defaultSessionLivenessProbe({ sessionId, pid: null }).live === false)

    // a burst of 3 messages to the now-DORMANT session -> exactly one resume
    deliverViaClaudeResume({ sessionId, cwd: agentCwd, pid: null, message: fixtureMessage(2) })
    deliverViaClaudeResume({ sessionId, cwd: agentCwd, pid: null, message: fixtureMessage(3) })
    deliverViaClaudeResume({ sessionId, cwd: agentCwd, pid: null, message: fixtureMessage(4) })
    await sleep(500)
    const runs = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean) : []
    check("dormant burst: exactly 1 resume process", runs.length === 1, `runs=${runs.length}`)
    // realpath: the fake claude reports $PWD, which resolves macOS's /var -> /private/var
    check("resume ran in the REGISTERED cwd (not the daemon's)", runs[0] === realpathSync(agentCwd) && runs[0] !== process.cwd(), runs[0])
  } finally {
    owner.kill("SIGKILL")
    bystander.kill("SIGKILL")
    if (prevBin == null) {
      delete process.env.AGENT_MESH_CLAUDE_BIN
    } else {
      process.env.AGENT_MESH_CLAUDE_BIN = prevBin
    }
    if (prevDebounce == null) {
      delete process.env.AGENT_MESH_RESUME_DEBOUNCE_MS
    } else {
      process.env.AGENT_MESH_RESUME_DEBOUNCE_MS = prevDebounce
    }
    rmSync(dir, { recursive: true, force: true })
  }
  return failures
}
