// End-to-end smoke for the mobile console, driven through a real browser.
//
// Run:  pnpm --dir agent-mesh run smoke          (needs agent-browser + a mesh daemon)
//
// ── What this asserts, and what it deliberately does not ─────────────────────
// Every assertion here is on a DETERMINISTIC surface: the author, type and time in an
// entry header, the raw payload behind the toggle, the receipt line, the digest counts.
// It never asserts on the assistant's recap, because that is model output — a smoke
// test that waits for an LLM is slow when it works and flaky when it does not, and a
// green run would then prove only that OpenAI was up.
//
// This also means the script needs no API key: with none set, an arrival still renders
// its raw body, which is exactly the fallback the console is built to have.
//
// ── Why it is not Playwright ─────────────────────────────────────────────────
// agent-browser drives a real Chrome with no extra test harness, against a console
// on its own port with its own SQLite file. The defect density in this feature is
// not in the UI shell anyway: it is in the inbound routing, which is covered by
// unit tests in `test-inbox-routing.ts`.
//
// ── Isolation is not optional here ───────────────────────────────────────────
// Every console on a box shares `~/.agent-mesh`. This script therefore points the
// transcript, the inbox cursor AND the push registration at its own throwaway files,
// and publishes to its own operator id. Without that, a scratch console advances the
// real inbox cursor, and synthetic rows written into the real transcript can replace
// real messages. Neither is recoverable, so the isolation comes first and the script
// refuses to run without it.

import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const PORT = Number(process.env.SMOKE_PORT ?? 4767)
// UNIQUE PER RUN, and this is not cosmetic. A mesh inbox is a durable Redis stream: a
// fixed id means run N+1 starts with every message run N published still sitting in it,
// unseen by the fresh transcript — so the digest correctly reports them as missed and
// the assertion fails for a reason that has nothing to do with the code under test.
// Isolating the files is not enough; the inbox is shared state too.
const OPERATOR = `console-smoke-${Date.now().toString(36)}`
const SENDER = "smoke-agent"
const SESSION = `console-smoke-${process.pid}`
const BASE = `http://127.0.0.1:${PORT}`
const MESH_ROOT = fileURLToPath(new URL("../..", import.meta.url))

let failures = 0
const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    console.log(`  [PASS] ${name}`)
    return
  }
  failures++
  console.error(`  [FAIL] ${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`)
}

const browser = (...args: string[]): string =>
  execFileSync("agent-browser", ["--session", SESSION, ...args], { encoding: "utf8", env: { ...process.env, AGENT_BROWSER_SESSION: SESSION } }).trim()

/** Read the page as text. Returns "" rather than throwing so a failure is an assertion, not a crash. */
const pageText = (): string => {
  try {
    return browser("eval", "(document.body.innerText||'')")
  } catch {
    return ""
  }
}

const publish = (args: { type: string; correlationId: string; body: Record<string, unknown> }): void => {
  execFileSync("agent-mesh", ["publish", "--to", OPERATOR, "--type", args.type, "--corr", args.correlationId, "--body", JSON.stringify(args.body)], {
    encoding: "utf8",
    env: { ...process.env, AGENT_MESH_ID: SENDER, AGENT_MESH_ID_EXPLICIT: "1", PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false" },
  })
}

/** Poll `probe` until it is true, or fail the named check on timeout. */
const until = async (name: string, probe: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (probe()) {
      return true
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  failures++
  console.error(`  [FAIL] ${name} — still false after ${timeoutMs}ms`)
  return false
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "console-smoke-"))
  console.log(`\n[console smoke] scratch=${scratch} port=${PORT} operator=${OPERATOR}`)

  const server = spawn("node", ["--import", "tsx", "src/ui-server.ts"], {
    cwd: MESH_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENT_MESH_UI_PORT: String(PORT),
      // All four overrides together. Any one missing and this writes into live state.
      AGENT_MESH_OPERATOR_ID: OPERATOR,
      CONSOLE_DATABASE_URL: `file:${join(scratch, "console.db")}`,
      CONSOLE_INBOX_HEAD_FILE: join(scratch, "head.json"),
      CONSOLE_PUSH_FILE: join(scratch, "push.json"),
    },
  })

  const cleanup = () => {
    server.kill()
    try {
      browser("close", "--all")
    } catch {
      /* the browser may already be gone; never let teardown mask a real failure */
    }
    rmSync(scratch, { recursive: true, force: true })
  }

  try {
    const up = await until(
      "server accepts requests",
      () => {
        try {
          execFileSync("curl", ["-sf", "--max-time", "2", `${BASE}/api/console/config`], { encoding: "utf8" })
          return true
        } catch {
          return false
        }
      },
      60_000,
    )
    if (!up) {
      return
    }

    const config = JSON.parse(execFileSync("curl", ["-s", `${BASE}/api/console/config`], { encoding: "utf8" })) as { operatorId: string }
    check("console runs under the scratch operator id", config.operatorId, OPERATOR)

    browser("set", "viewport", "393", "852")
    browser("open", `${BASE}/?mobile=1`)

    // ── an agent message renders as one attributed, collapsible entry ─────────
    publish({ type: "result", correlationId: "smoke-1", body: { run: "smoke run", state: "COMPLETE", slides: 42 } })

    await until("an arriving message reaches the chat", () => pageText().includes("smoke run"), 45_000)
    const afterArrival = pageText()
    check("the entry is attributed to its sender", afterArrival.includes(SENDER), true)
    check("the entry carries the mesh message type", afterArrival.toLowerCase().includes("result"), true)
    check("the raw payload is collapsed behind an affordance", afterArrival.includes("Show original"), true)
    // The correlation id is the right probe for collapsed-vs-expanded, and the entry
    // text is not. With no API key the recap never arrives and the entry falls back to
    // showing the raw body — by design — so asserting the body is hidden would be
    // asserting against the fallback the console is built to have. The correlation id
    // appears ONLY inside the expanded details, whether or not narration ran.
    check("the correlation id is not shown until asked for", afterArrival.includes("smoke-1"), false)

    browser("find", "role", "button", "click", "--name", "Show original")
    const expanded = await until("expanding reveals the raw payload", () => pageText().includes("smoke-1"), 10_000)
    if (expanded) {
      const afterExpand = pageText()
      check("the raw payload shows every field, not a preview", [afterExpand.includes("42"), afterExpand.includes("COMPLETE")], [true, true])
    }
    browser("screenshot", join(scratch, "01-arrival-expanded.png"))

    // ── the digest counts what the conversation never showed them ────────────
    // Published BEFORE the mark is rewound, so it is genuinely unseen.
    publish({ type: "blocker", correlationId: "smoke-2", body: { blocker: "a decision is needed" } })
    await until("the second message arrives", () => pageText().includes("a decision is needed"), 45_000)

    // The transcript save is debounced, and the digest reads the STORED copy to decide
    // what they have seen. Querying before it lands reports their own open conversation back
    // to them as things they missed.
    type Digest = { arrived: number; needsYou: { from: string; type: string; correlationId: string | null }[] }
    const readDigest = (): Digest =>
      JSON.parse(execFileSync("curl", ["-s", `${BASE}/api/console/digest?since=2020-01-01T00:00:00Z`], { encoding: "utf8" })) as Digest
    // Scoped to THIS run's correlations, never absolute counts: the operator view
    // merges the mesh-wide broadcast stream, so a box with other agents on it has
    // unrelated traffic in the window and an absolute count asserts on the weather.
    const smokeMissed = () => readDigest().needsYou.filter((n) => n.correlationId === "smoke-2")

    // The precondition is asserted SEPARATELY from the behaviour. If the transcript
    // never persists the entry, that is the failure worth reporting — folding the two
    // together produces "the digest is wrong" for a storage problem, which sends the
    // next reader to the wrong file.
    const storedRawIds = (): string[] => {
      const t = JSON.parse(execFileSync("curl", ["-s", `${BASE}/api/console/transcript?conversation=default`], { encoding: "utf8" })) as {
        messages: { metadata?: { raw?: { correlationId: string | null }[] } }[]
      }
      return t.messages.flatMap((m) => (m.metadata?.raw ?? []).map((r) => r.correlationId ?? ""))
    }
    const stored = await until("the rendered blocker reaches the durable transcript", () => storedRawIds().includes("smoke-2"), 30_000)
    if (stored) {
      check("a message the chat has already shown them is not reported as missed", smokeMissed().length, 0)
    }

    // ── a reply to a chat that is not on screen lands in THAT chat ───────────
    // By the time it arrives the inbox has advanced past it and this browser has marked
    // it seen, so if the on-screen chat drops it, nothing can bring it back.
    const ELSEWHERE = "smoke-elsewhere"
    const transcriptOf = (conversation: string): { messages: { metadata?: { raw?: { correlationId: string | null }[] } }[] } =>
      JSON.parse(execFileSync("curl", ["-s", `${BASE}/api/console/transcript?conversation=${conversation}`], { encoding: "utf8" }))
    const rawCorrelations = (conversation: string): string[] =>
      transcriptOf(conversation).messages.flatMap((m) => (m.metadata?.raw ?? []).map((r) => r.correlationId ?? ""))
    // The question, asked from another chat: its correlation is what makes that chat the owner.
    const question = { id: "smoke-question", role: "user", metadata: { correlationId: "smoke-3" }, parts: [{ type: "text", text: "asked elsewhere" }] }
    execFileSync("curl", ["-sf", "-X", "PUT", "-H", "Content-Type: application/json", "--data", JSON.stringify({ messages: [question] }), `${BASE}/api/console/transcript?conversation=${ELSEWHERE}`])
    publish({ type: "result", correlationId: "smoke-3", body: { answer: "the elsewhere answer" } })
    const landed = await until("a reply to an off-screen chat is stored in that chat", () => rawCorrelations(ELSEWHERE).includes("smoke-3"), 45_000)
    if (landed) {
      check("and not in the chat that happened to be open", [pageText().includes("the elsewhere answer"), rawCorrelations("default").includes("smoke-3")], [false, false])
    }

    // ── an arrival for a chat that is not on screen is still recapped ────────
    // The narration endpoint is stubbed with a fixed stream, so this asserts on the
    // console's handling of a recap and never on model output.
    const RECAP = "smoke recap for the other chat"
    const chunks = [
      { type: "start", messageId: "smoke-recap" },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: RECAP },
      { type: "text-end", id: "t" },
      { type: "finish" },
    ]
    browser("network", "route", "**/api/console/narrate", "--body", `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`)
    const RECAPPED = "smoke-recapped"
    const asked = { id: "smoke-question-2", role: "user", metadata: { correlationId: "smoke-4" }, parts: [{ type: "text", text: "asked elsewhere" }] }
    execFileSync("curl", ["-sf", "-X", "PUT", "-H", "Content-Type: application/json", "--data", JSON.stringify({ messages: [asked] }), `${BASE}/api/console/transcript?conversation=${RECAPPED}`])
    publish({ type: "result", correlationId: "smoke-4", body: { answer: "raw answer for the other chat" } })
    const storedTexts = (conversation: string): string[] =>
      (JSON.parse(execFileSync("curl", ["-s", `${BASE}/api/console/transcript?conversation=${conversation}`], { encoding: "utf8" })) as { messages: { parts: { text?: string }[] }[] }).messages.flatMap((m) =>
        m.parts.map((p) => p.text ?? ""),
      )
    await until("an off-screen arrival is stored with its recap", () => storedTexts(RECAPPED).includes(RECAP), 45_000)
    browser("network", "unroute")

    // ── receipts describe a message THEY sent, and never guess ───────────────
    const receipt = JSON.parse(
      execFileSync("curl", ["-s", `${BASE}/api/console/receipts?correlationId=smoke-1&to=${SENDER}`], { encoding: "utf8" }),
    ) as { delivered: boolean | null; deliveredReason: string; answered: boolean }
    check("a correlation they never sent on is not reported as undelivered", receipt.delivered, null)
    check("and it says why, rather than implying failure", receipt.deliveredReason, "no-request-from-you")
    check("a reply on that correlation still counts as answered", receipt.answered, true)

    browser("screenshot", join(scratch, "02-final.png"))
  } finally {
    cleanup()
  }

  console.log(`\n${"=".repeat(46)}\n${failures === 0 ? "✅ CONSOLE SMOKE PASSED" : `❌ ${failures} CHECK(S) FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
