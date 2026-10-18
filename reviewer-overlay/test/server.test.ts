import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, beforeEach, describe, it } from "node:test"
import {
  buildMessageBody,
  MAX_COMMENT_CHARS,
  MAX_MESH_BODY_BYTES,
  MAX_META_TEXT_CHARS,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES,
  MAX_TOTAL_POINTS,
  MAX_URL_CHARS,
  reviewRequestSchema,
} from "../src/contract.ts"
import { ConfigError, parseConfig, type ServerConfig } from "../src/server/config.ts"
import { createMeshCliPublisher, type Exec, type PublishArgument, type PublishResult } from "../src/server/publish.ts"
import { createReviewHandler } from "../src/server/server.ts"
import { newReportFiles } from "../src/server/storage.ts"

const APP_ORIGIN = "http://localhost:5173"
const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

type Reply = { status: number; headers: IncomingHttpHeaders; json: Record<string, unknown> | null; text: string }

let root: string
let server: Server
let port: number
let config: ServerConfig
let publishCalls: PublishArgument[]
let publishResult: PublishResult

function send(args: {
  method: string
  path: string
  headers: Record<string, string>
  body: string | null
  chunked: boolean
}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: args.method, path: args.path, headers: { host: `127.0.0.1:${port}`, ...args.headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let json: Record<string, unknown> | null = null
          try {
            json = JSON.parse(text) as Record<string, unknown>
          } catch {
            json = null
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text })
        })
      },
    )
    // The server may close the socket after a 413 while the body is still being
    // written; the response has already arrived by then.
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") {
        reject(error)
      }
    })
    if (args.body != null) {
      if (args.chunked) {
        const size = 64 * 1024
        for (let offset = 0; offset < args.body.length; offset += size) {
          req.write(args.body.slice(offset, offset + size))
        }
      } else {
        req.setHeader("content-length", Buffer.byteLength(args.body))
        req.write(args.body)
      }
    }
    req.end()
  })
}

function validReview(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    comment: "The button label is cut off",
    url: `${APP_ORIGIN}/settings`,
    pin: { n: 1, xPct: 40.5, yPct: 22.1, pageX: 518, pageY: 133 },
    meta: { title: "Settings", viewport: { w: 1280, h: 600, dpr: 1 }, userAgent: "test" },
    screenshotDataUrl: PNG_1X1,
    capturedAt: "2026-10-16T10:00:00.000Z",
    targetAgentId: null,
    strokes: null,
    ...overrides,
  }
}

function postReview(args: { body: Record<string, unknown> | string; origin: string | null }): Promise<Reply> {
  return send({
    method: "POST",
    path: "/api/review",
    headers: {
      "content-type": "application/json",
      ...(args.origin == null ? {} : { origin: args.origin }),
    },
    body: typeof args.body === "string" ? args.body : JSON.stringify(args.body),
    chunked: false,
  })
}

async function reportFiles(): Promise<string[]> {
  try {
    return (await readdir(config.reportDir)).sort()
  } catch {
    return []
  }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "reviewer-overlay-test-"))
  await writeFile(join(root, "plan.json"), JSON.stringify({ title: "Plan", features: [{ id: "f1", title: "One", steps: ["a"] }] }))
  await writeFile(join(root, "reviewer-overlay.iife.js"), "console.log('overlay')\n")
  config = {
    port: 0,
    origins: [APP_ORIGIN],
    targetAgentId: "default-agent",
    reporterId: "reviewer-overlay",
    allowTargetOverride: true,
    planPath: join(root, "plan.json"),
    reportDir: join(root, "reports"),
    meshCommand: ["agent-mesh"],
    publishTimeoutMs: 1000,
    maxBodyBytes: 64 * 1024,
    allowedHosts: [],
  }
  server = createServer(
    createReviewHandler({
      config,
      publisher: async (argument) => {
        publishCalls.push(argument)
        return publishResult
      },
      clientDir: root,
      now: () => new Date("2026-10-16T10:00:00.000Z"),
    }),
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  publishCalls = []
  publishResult = { ok: true, messageId: "1760608800000-0" }
  config.allowTargetOverride = true
  await rm(config.reportDir, { recursive: true, force: true })
})

describe("CORS", () => {
  it("answers a preflight from an allowed origin", async () => {
    const reply = await send({
      method: "OPTIONS",
      path: "/api/review",
      headers: { origin: APP_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      body: null,
      chunked: false,
    })
    assert.equal(reply.status, 204)
    assert.equal(reply.headers["access-control-allow-origin"], APP_ORIGIN)
    assert.match(String(reply.headers["access-control-allow-methods"]), /POST/)
    assert.match(String(reply.headers["access-control-allow-headers"]), /content-type/)
    assert.equal(reply.headers["access-control-allow-private-network"], undefined)
  })

  it("allows private-network preflights only when asked", async () => {
    const reply = await send({
      method: "OPTIONS",
      path: "/api/review",
      headers: { origin: APP_ORIGIN, "access-control-request-private-network": "true" },
      body: null,
      chunked: false,
    })
    assert.equal(reply.status, 204)
    assert.equal(reply.headers["access-control-allow-private-network"], "true")
  })

  it("refuses a preflight from another origin", async () => {
    const reply = await send({
      method: "OPTIONS",
      path: "/api/review",
      headers: { origin: "http://evil.example" },
      body: null,
      chunked: false,
    })
    assert.equal(reply.status, 403)
    assert.equal(reply.headers["access-control-allow-origin"], undefined)
  })

  it("serves the plan to an allowed origin with CORS headers", async () => {
    const reply = await send({ method: "GET", path: "/api/review", headers: { origin: APP_ORIGIN }, body: null, chunked: false })
    assert.equal(reply.status, 200)
    assert.equal(reply.headers["access-control-allow-origin"], APP_ORIGIN)
    assert.equal(reply.json?.targetAgentId, "default-agent")
    assert.equal((reply.json?.plan as { title: string }).title, "Plan")
    assert.equal(reply.json?.planError, null)
  })

  it("refuses to serve the plan to another origin", async () => {
    const reply = await send({ method: "GET", path: "/api/review", headers: { origin: "http://evil.example" }, body: null, chunked: false })
    assert.equal(reply.status, 403)
    assert.equal(reply.headers["access-control-allow-origin"], undefined)
    assert.equal(reply.json?.plan, undefined)
  })

  it("refuses a POST from another origin without publishing", async () => {
    const reply = await postReview({ body: validReview({}), origin: "http://localhost:5174" })
    assert.equal(reply.status, 403)
    assert.equal(publishCalls.length, 0)
    assert.deepEqual(await reportFiles(), [])
  })

  it("refuses a POST with no Origin header", async () => {
    const reply = await postReview({ body: validReview({}), origin: null })
    assert.equal(reply.status, 403)
    assert.equal(publishCalls.length, 0)
  })

  it("refuses a request whose Host is not loopback (DNS rebinding)", async () => {
    const reply = await send({
      method: "GET",
      path: "/api/review",
      headers: { host: "rebind.example:4848", origin: APP_ORIGIN },
      body: null,
      chunked: false,
    })
    assert.equal(reply.status, 403)
    assert.equal(reply.json?.error, "forbiddenHost")
  })

  it("accepts localhost as Host", async () => {
    const reply = await send({ method: "GET", path: "/api/review", headers: { host: `localhost:${port}` }, body: null, chunked: false })
    assert.equal(reply.status, 200)
  })
})

describe("size cap", () => {
  it("refuses a declared Content-Length over the cap", async () => {
    const reply = await postReview({ body: validReview({ comment: "x".repeat(70 * 1024) }), origin: APP_ORIGIN })
    assert.equal(reply.status, 413)
    assert.equal(reply.json?.error, "tooLarge")
    assert.equal(publishCalls.length, 0)
  })

  it("refuses a chunked body once it passes the cap", async () => {
    const reply = await send({
      method: "POST",
      path: "/api/review",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(validReview({ screenshotDataUrl: `data:image/png;base64,${"A".repeat(200 * 1024)}` })),
      chunked: true,
    })
    assert.equal(reply.status, 413)
    assert.equal(publishCalls.length, 0)
    assert.deepEqual(await reportFiles(), [])
  })
})

describe("validation", () => {
  const cases: Array<[string, Record<string, unknown> | string, number, string]> = [
    ["invalid JSON", "{not json", 400, "invalidBody"],
    ["an empty review", validReview({ comment: "  ", pin: null, screenshotDataUrl: null, strokes: null }), 400, "invalidRequest"],
    ["a comment over the limit", validReview({ comment: "x".repeat(MAX_COMMENT_CHARS + 1) }), 400, "invalidRequest"],
    ["an agent id with a colon", validReview({ targetAgentId: "mesh:inbox:x" }), 400, "invalidRequest"],
    ["an agent id with a slash", validReview({ targetAgentId: "../other" }), 400, "invalidRequest"],
    ["a page url on another origin", validReview({ url: "http://evil.example/x" }), 400, "invalidUrl"],
    ["a non-http page url", validReview({ url: "javascript:alert(1)" }), 400, "invalidUrl"],
    ["a non-PNG screenshot", validReview({ screenshotDataUrl: "data:image/jpeg;base64,/9j/4AAQ" }), 400, "invalidScreenshot"],
    ["PNG data URL that is not a PNG", validReview({ screenshotDataUrl: "data:image/png;base64,aGVsbG8gd29ybGQgaGVsbG8gd29ybGQ=" }), 400, "invalidScreenshot"],
    [
      "strokes next to a screenshot",
      validReview({ strokes: [{ points: [{ xPct: 1, yPct: 1 }] }] }),
      400,
      "invalidRequest",
    ],
    ["a missing field", (() => { const review = validReview({}); delete review.capturedAt; return review })(), 400, "invalidRequest"],
  ]
  for (const [name, body, status, error] of cases) {
    it(`rejects ${name}`, async () => {
      const reply = await postReview({ body, origin: APP_ORIGIN })
      assert.equal(reply.status, status)
      assert.equal(reply.json?.error, error)
      assert.equal(publishCalls.length, 0)
      assert.deepEqual(await reportFiles(), [])
    })
  }

  it("rejects a body that is not JSON-typed", async () => {
    const reply = await send({
      method: "POST",
      path: "/api/review",
      headers: { origin: APP_ORIGIN, "content-type": "text/plain" },
      body: JSON.stringify(validReview({})),
      chunked: false,
    })
    assert.equal(reply.status, 415)
    assert.equal(publishCalls.length, 0)
  })

  it("accepts a pin-only review with vector strokes and no screenshot", async () => {
    const reply = await postReview({
      body: validReview({ comment: "", screenshotDataUrl: null, strokes: [{ points: [{ xPct: 10, yPct: 10 }, { xPct: 12, yPct: 14 }] }] }),
      origin: APP_ORIGIN,
    })
    assert.equal(reply.status, 200)
    assert.equal(publishCalls[0]?.body.screenshot, null)
    assert.deepEqual(publishCalls[0]?.body.strokes, [{ points: [{ xPct: 10, yPct: 10 }, { xPct: 12, yPct: 14 }] }])
  })
})

describe("path safety", () => {
  it("names files from the server clock and a UUID only", async () => {
    const reply = await postReview({
      body: validReview({ capturedAt: "../../../../tmp/owned", url: `${APP_ORIGIN}/../../x?f=../../y` }),
      origin: APP_ORIGIN,
    })
    assert.equal(reply.status, 200)
    const files = await reportFiles()
    assert.equal(files.length, 2)
    for (const file of files) {
      assert.match(file, /^review-20261016100000000-[0-9a-f-]{36}\.(png|json)$/)
    }
    assert.deepEqual((await readdir(root)).sort(), ["plan.json", "reports", "reviewer-overlay.iife.js"])
    assert.equal(reply.json?.screenshotPath, join(config.reportDir, files.find((file) => file.endsWith(".png")) ?? ""))
  })

  it("keeps generated paths inside the report directory", () => {
    const files = newReportFiles({ dir: join(root, "reports", "..", "reports"), now: new Date() })
    assert.ok(files.pngPath.startsWith(join(root, "reports") + "/"))
    assert.ok(files.jsonPath.startsWith(join(root, "reports") + "/"))
  })
})

describe("publishing", () => {
  it("publishes the ui-review note and returns the message id", async () => {
    const reply = await postReview({ body: validReview({}), origin: APP_ORIGIN })
    assert.equal(reply.status, 200)
    assert.equal(reply.json?.ok, true)
    assert.equal(reply.json?.meshMessageId, "1760608800000-0")
    assert.equal(reply.json?.targetAgentId, "default-agent")
    assert.equal(publishCalls.length, 1)
    const call = publishCalls[0]
    assert.equal(call?.from, "reviewer-overlay")
    assert.equal(call?.to, "default-agent")
    assert.deepEqual(Object.keys(call?.body ?? {}).sort(), [
      "capturedAt",
      "comment",
      "kind",
      "meta",
      "note",
      "pin",
      "reporter",
      "screenshot",
      "screenshotBucket",
      "screenshotKey",
      "screenshotUrl",
      "strokes",
      "url",
    ])
    assert.equal(call?.body.kind, "ui-review-comment")
    assert.equal(call?.body.comment, "The button label is cut off")
    const png = await readFile(String(call?.body.screenshot))
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG")
    const report = JSON.parse(await readFile(String(reply.json?.reportPath), "utf8")) as {
      delivery: { status: string; meshMessageId: string }
      message: { type: string; correlationId: string; to: string }
    }
    assert.deepEqual(report.delivery, { status: "published", meshMessageId: "1760608800000-0" })
    assert.equal(report.message.type, "note")
    assert.equal(report.message.correlationId, "ui-review")
  })

  it("uses the target from the overlay when overrides are allowed", async () => {
    await postReview({ body: validReview({ targetAgentId: "picked-agent" }), origin: APP_ORIGIN })
    assert.equal(publishCalls[0]?.to, "picked-agent")
  })

  it("ignores the overlay's target when overrides are off", async () => {
    config.allowTargetOverride = false
    await postReview({ body: validReview({ targetAgentId: "picked-agent" }), origin: APP_ORIGIN })
    assert.equal(publishCalls[0]?.to, "default-agent")
  })

  it("surfaces a publish failure to the UI and keeps the report", async () => {
    publishResult = { ok: false, error: "agent-mesh publish failed: cannot reach the daemon" }
    const reply = await postReview({ body: validReview({}), origin: APP_ORIGIN })
    assert.equal(reply.status, 502)
    assert.equal(reply.json?.ok, false)
    assert.equal(reply.json?.error, "publishFailed")
    assert.equal(reply.json?.message, "agent-mesh publish failed: cannot reach the daemon")
    assert.equal(reply.headers["access-control-allow-origin"], APP_ORIGIN)
    const report = JSON.parse(await readFile(String(reply.json?.reportPath), "utf8")) as {
      delivery: { status: string; error: string }
      message: { body: { comment: string } }
    }
    assert.deepEqual(report.delivery, { status: "failed", error: "agent-mesh publish failed: cannot reach the daemon" })
    assert.equal(report.message.body.comment, "The button label is cut off")
  })
})

describe("mesh CLI publisher", () => {
  function fakeExec(result: { error: (Error & { killed?: boolean }) | null; stdout: string; stderr: string }) {
    const calls: Array<{ file: string; args: string[] }> = []
    const exec: Exec = async ({ file, args }) => {
      calls.push({ file, args })
      return result
    }
    return { exec, calls }
  }
  const argument = { from: "reviewer-overlay", to: "agent-1", body: { kind: "ui-review-comment", comment: "hi" } }

  it("reads the message id from the published line", async () => {
    const { exec, calls } = fakeExec({ error: null, stdout: "published 1760608800000-0 -> agent-1 (note)\n", stderr: "" })
    const publish = createMeshCliPublisher({ command: ["pnpm", "--dir", "/x", "exec", "tsx", "src/cli.ts"], timeoutMs: 1000, exec })
    assert.deepEqual(await publish(argument), { ok: true, messageId: "1760608800000-0" })
    assert.equal(calls[0]?.file, "pnpm")
    assert.deepEqual(calls[0]?.args, [
      "--dir",
      "/x",
      "exec",
      "tsx",
      "src/cli.ts",
      "publish",
      "--id",
      "reviewer-overlay",
      "--to",
      "agent-1",
      "--type",
      "note",
      "--corr",
      "ui-review",
      "--body",
      JSON.stringify(argument.body),
    ])
  })

  it("treats exit 0 without a published line as a failure", async () => {
    const { exec } = fakeExec({ error: null, stdout: "usage: agent-mesh <command>\n", stderr: "" })
    const result = await createMeshCliPublisher({ command: ["agent-mesh"], timeoutMs: 1000, exec })(argument)
    assert.equal(result.ok, false)
    assert.match(result.ok ? "" : result.error, /did not confirm the publish/)
  })

  it("treats a published line for another recipient as a failure", async () => {
    const { exec } = fakeExec({ error: null, stdout: "published 1-0 -> someone-else (note)\n", stderr: "" })
    const result = await createMeshCliPublisher({ command: ["agent-mesh"], timeoutMs: 1000, exec })(argument)
    assert.equal(result.ok, false)
  })

  it("reports stderr on a non-zero exit", async () => {
    const { exec } = fakeExec({
      error: Object.assign(new Error("Command failed"), { code: 1 }),
      stdout: "",
      stderr: "agent-mesh: connect ENOENT /home/x/.agent-mesh/daemon.sock\n",
    })
    const result = await createMeshCliPublisher({ command: ["agent-mesh"], timeoutMs: 1000, exec })(argument)
    assert.deepEqual(result, { ok: false, error: "agent-mesh publish failed: agent-mesh: connect ENOENT /home/x/.agent-mesh/daemon.sock" })
  })

  it("reports a timeout", async () => {
    const { exec } = fakeExec({ error: Object.assign(new Error("killed"), { killed: true }), stdout: "", stderr: "" })
    const result = await createMeshCliPublisher({ command: ["agent-mesh"], timeoutMs: 1234, exec })(argument)
    assert.deepEqual(result, { ok: false, error: "agent-mesh publish timed out after 1234 ms" })
  })

  it("reports a missing binary", async () => {
    const publish = createMeshCliPublisher({ command: ["reviewer-overlay-no-such-binary"], timeoutMs: 1000, exec: null })
    const result = await publish(argument)
    assert.equal(result.ok, false)
    assert.match(result.ok ? "" : result.error, /ENOENT/)
  })
})

describe("mesh body size", () => {
  it("keeps the worst-case body under the argv-safe cap", () => {
    // \u0001 serialises as six bytes, the worst case for JSON escaping.
    const nasty = "\u0001"
    const perStroke = Math.floor(MAX_TOTAL_POINTS / MAX_STROKES)
    assert.ok(perStroke <= MAX_POINTS_PER_STROKE)
    const review = reviewRequestSchema.parse({
      comment: nasty.repeat(MAX_COMMENT_CHARS),
      url: `${APP_ORIGIN}/${"\"".repeat(MAX_URL_CHARS - APP_ORIGIN.length - 1)}`,
      pin: { n: 99999, xPct: 99.9, yPct: 99.9, pageX: 99999, pageY: 99999 },
      meta: {
        title: nasty.repeat(MAX_META_TEXT_CHARS),
        viewport: { w: 99999, h: 99999, dpr: 2.5 },
        userAgent: nasty.repeat(MAX_META_TEXT_CHARS),
      },
      screenshotDataUrl: null,
      capturedAt: "2026-10-16T10:00:00.000Z",
      targetAgentId: "a".repeat(128),
      strokes: Array.from({ length: MAX_STROKES }, () => ({
        points: Array.from({ length: perStroke }, () => ({ xPct: 99.9, yPct: 99.9 })),
      })),
    })
    const body = buildMessageBody({ review, screenshotPath: `/${"d".repeat(400)}/review.png`, reporterId: "r".repeat(128) })
    const bytes = Buffer.byteLength(JSON.stringify(body))
    assert.ok(bytes < MAX_MESH_BODY_BYTES, `worst case is ${bytes} bytes`)
    assert.ok(MAX_MESH_BODY_BYTES < 128 * 1024)
  })
})

describe("plan loading", () => {
  async function planReply(content: string | null): Promise<Reply> {
    if (content == null) {
      await rm(config.planPath, { force: true })
    } else {
      await writeFile(config.planPath, content)
    }
    return send({ method: "GET", path: "/api/review", headers: { origin: APP_ORIGIN }, body: null, chunked: false })
  }

  after(async () => {
    await writeFile(config.planPath, JSON.stringify({ title: "Plan", features: [{ id: "f1", title: "One", steps: ["a"] }] }))
  })

  it("returns null when there is no plan file", async () => {
    const reply = await planReply(null)
    assert.equal(reply.json?.plan, null)
    assert.equal(reply.json?.planError, null)
  })

  it("explains invalid JSON", async () => {
    const reply = await planReply("{")
    assert.equal(reply.json?.plan, null)
    assert.match(String(reply.json?.planError), /not valid JSON/)
  })

  it("explains a schema mismatch", async () => {
    const reply = await planReply(JSON.stringify({ features: [{ steps: [42] }] }))
    assert.equal(reply.json?.plan, null)
    assert.match(String(reply.json?.planError), /features\.0\.steps\.0/)
  })

  it("keeps unknown fields and copy blocks", async () => {
    const plan = {
      title: "T",
      appBase: "http://localhost:5173",
      features: [{ id: "f1", tag: "instant", steps: [{ text: "run", copy: [{ kind: "command", label: "shell", text: "ls" }] }], extra: 1 }],
    }
    const reply = await planReply(JSON.stringify(plan))
    assert.deepEqual(reply.json?.plan, plan)
  })
})

describe("client bundle", () => {
  it("serves the script bundle", async () => {
    const reply = await send({ method: "GET", path: "/reviewer-overlay.js", headers: {}, body: null, chunked: false })
    assert.equal(reply.status, 200)
    assert.match(String(reply.headers["content-type"]), /javascript/)
    assert.equal(reply.text, "console.log('overlay')\n")
  })

  it("says how to build a missing bundle", async () => {
    const reply = await send({ method: "GET", path: "/reviewer-overlay.mjs", headers: {}, body: null, chunked: false })
    assert.equal(reply.status, 503)
    assert.match(reply.text, /pnpm build/)
  })

  it("returns 404 for anything else", async () => {
    const reply = await send({ method: "GET", path: "/../../etc/passwd", headers: {}, body: null, chunked: false })
    assert.equal(reply.status, 404)
  })
})

describe("config", () => {
  const env = {}
  it("requires an origin and a target", () => {
    assert.throws(() => parseConfig({ argv: ["--target", "a"], env, cwd: "/w" }), ConfigError)
    assert.throws(() => parseConfig({ argv: ["--origin", APP_ORIGIN], env, cwd: "/w" }), ConfigError)
  })

  it("rejects an origin with a path or a wildcard", () => {
    assert.throws(() => parseConfig({ argv: ["--origin", `${APP_ORIGIN}/app`, "--target", "a"], env, cwd: "/w" }), ConfigError)
    assert.throws(() => parseConfig({ argv: ["--origin", "*", "--target", "a"], env, cwd: "/w" }), ConfigError)
  })

  it("rejects unknown flags", () => {
    assert.throws(() => parseConfig({ argv: ["--origin", APP_ORIGIN, "--target", "a", "--bind", "0.0.0.0"], env, cwd: "/w" }))
  })

  it("parses defaults", () => {
    const parsed = parseConfig({ argv: ["--origin", `${APP_ORIGIN}/`, "--target", "agent.1"], env, cwd: "/w" })
    assert.notEqual(parsed, "help")
    if (parsed === "help") {
      return
    }
    assert.deepEqual(parsed.origins, [APP_ORIGIN])
    assert.equal(parsed.port, 4848)
    assert.equal(parsed.planPath, "/w/untracked/review-plan.json")
    assert.equal(parsed.reportDir, "/w/untracked/review-overlay-report")
    assert.deepEqual(parsed.meshCommand, ["agent-mesh"])
    assert.equal(parsed.allowTargetOverride, false)
  })

  it("uses the panel's target only with --allow-target-override", () => {
    const parsed = parseConfig({ argv: ["--origin", APP_ORIGIN, "--target", "agent.1", "--allow-target-override"], env, cwd: "/w" })
    assert.notEqual(parsed, "help")
    if (parsed === "help") {
      return
    }
    assert.equal(parsed.allowTargetOverride, true)
  })

  it("reads origins and the target from the environment", () => {
    const parsed = parseConfig({
      argv: ["--mesh-cli", "[\"node\", \"/path with space/cli.js\"]"],
      env: { REVIEWER_OVERLAY_ORIGINS: `${APP_ORIGIN}, http://127.0.0.1:3000`, REVIEW_TARGET_AGENT_ID: "agent.2" },
      cwd: "/w",
    })
    assert.notEqual(parsed, "help")
    if (parsed === "help") {
      return
    }
    assert.deepEqual(parsed.origins, [APP_ORIGIN, "http://127.0.0.1:3000"])
    assert.equal(parsed.targetAgentId, "agent.2")
    assert.deepEqual(parsed.meshCommand, ["node", "/path with space/cli.js"])
  })
})
