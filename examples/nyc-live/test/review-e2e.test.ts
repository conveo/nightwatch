import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createServer, request, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import {
  answers,
  noteProblems,
  NOTE_TEXT,
  parseInbox,
  pngSize,
  PROXY_HOST,
  REVIEW_VIEW,
  startProxy,
  type InboxMessage,
} from "../scripts/review-e2e.ts"
import { serializeViewState } from "../src/view-state.ts"

// test/fixtures/review-note.png is the screenshot a real run of
// scripts/review-e2e.ts received in the reviewer's inbox, and test/recordings/
// holds the Decisions API's real answers for it, so this needs no key.
test("the recorded review-note screenshot passes its checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(
    process.execPath,
    ["scripts/check-visual.ts", "test/fixtures/review-note.png", "checks/review-note.json", "--replay"],
    { encoding: "utf8", env },
  )
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 2, run.stdout)
})

test("the review opens the venue with its building selected", () => {
  assert.match(serializeViewState(REVIEW_VIEW), /&sel=bin:1007945&/)
})

const ORIGIN = "http://127.0.0.1:5180"
const goodNote = (): InboxMessage => ({
  id: "1792363669202-0",
  from: "reviewer-overlay",
  type: "note",
  corr: "ui-review",
  body: {
    kind: "ui-review-comment",
    comment: NOTE_TEXT,
    url: `${ORIGIN}/${serializeViewState(REVIEW_VIEW)}`,
    pin: { n: 1, xPct: 50, yPct: 50, pageX: 800, pageY: 350 },
    screenshot: "/reports/review.png",
  },
})
const expectation = { comment: NOTE_TEXT, origin: ORIGIN, view: REVIEW_VIEW }
const withBody = (body: Record<string, unknown>): InboxMessage => {
  const note = goodNote()
  return { ...note, body: { ...(note.body as object), ...body } }
}

test("the inbox's lines parse into messages", () => {
  const note = goodNote()
  const stdout = [
    `${note.id}  ${note.from} -> note [ui-review]: ${JSON.stringify(note.body)}`,
    `1792363669300-0  someone -> status: {"milestone":"x"}`,
    "(no new messages)",
  ].join("\n")
  const messages = parseInbox(stdout)
  assert.deepEqual(messages[0], note)
  assert.deepEqual(messages[1], { id: "1792363669300-0", from: "someone", type: "status", corr: null, body: { milestone: "x" } })
  assert.equal(messages.length, 2)
})

test("a note with the comment, the open view, a centred pin and a screenshot holds", () => {
  assert.deepEqual(noteProblems(goodNote(), expectation), [])
})

test("a note whose page URL is another view does not hold", () => {
  const moved = serializeViewState({ ...REVIEW_VIEW, cam: [0, 900, 1] })
  const problems = noteProblems(withBody({ url: `${ORIGIN}/${moved}` }), expectation)
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /is not the open view/)
  assert.match(noteProblems(withBody({ url: `${ORIGIN}/#mode=fixture` }), expectation)[0]!, /is not the open view/)
})

test("a note from another origin, without the comment, pin or screenshot does not hold", () => {
  assert.match(noteProblems(withBody({ url: `http://127.0.0.1:9999/${serializeViewState(REVIEW_VIEW)}` }), expectation)[0]!, /not http:\/\/127\.0\.0\.1:5180/)
  assert.match(noteProblems(withBody({ comment: "" }), expectation)[0]!, /the comment is ""/)
  assert.match(noteProblems(withBody({ pin: null }), expectation)[0]!, /no pin #1/)
  assert.match(noteProblems(withBody({ pin: { n: 1, xPct: 80, yPct: 50 } }), expectation)[0]!, /not on the venue/)
  assert.match(noteProblems(withBody({ screenshot: null }), expectation)[0]!, /no screenshot/)
  assert.match(noteProblems({ ...goodNote(), corr: "other" }, expectation)[0]!, /correlation id/)
})

test("pngSize reads a PNG's size and refuses other bytes", () => {
  assert.deepEqual(pngSize(readFileSync("test/fixtures/review-note.png")), { width: 1600, height: 700 })
  assert.equal(pngSize(Buffer.from("not a png at all, just some text")), null)
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return (server.address() as AddressInfo).port
}

const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })

test("the proxy forwards requests with the browser's Host header", async () => {
  const seen: Array<{ host?: string; url?: string }> = []
  const upstream = createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url })
    res.statusCode = req.url === "/missing" ? 404 : 200
    res.end("ok")
  })
  const proxy = await startProxy(await listen(upstream))
  try {
    const port = (proxy.address() as AddressInfo).port
    assert.equal(await answers(`http://${PROXY_HOST}:${port}/reviewer-overlay.js?v=1`), true)
    assert.equal(await answers(`http://${PROXY_HOST}:${port}/missing`), false)
    assert.deepEqual(seen[0], { host: `${PROXY_HOST}:${port}`, url: "/reviewer-overlay.js?v=1" })
  } finally {
    await close(proxy)
    await close(upstream)
  }
})

test("the proxy forwards WebSocket upgrades, such as the dev server's", async () => {
  const upstream = createServer()
  upstream.on("upgrade", (req, socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Host: ${req.headers.host}\r\n\r\n`)
    socket.on("data", (data) => socket.write(data))
    socket.on("end", () => socket.end())
  })
  const proxy = await startProxy(await listen(upstream))
  const port = (proxy.address() as AddressInfo).port
  try {
    const { echo, seenHost } = await new Promise<{ echo: string; seenHost: unknown }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        headers: { host: `${PROXY_HOST}:${port}`, connection: "Upgrade", upgrade: "websocket" },
      })
      req.on("upgrade", (res, socket) => {
        socket.once("data", (data) => {
          resolve({ echo: data.toString(), seenHost: res.headers["x-seen-host"] })
          socket.destroy()
        })
        socket.write("ping")
      })
      req.on("error", reject)
      req.end()
    })
    assert.equal(echo, "ping")
    assert.equal(seenHost, `${PROXY_HOST}:${port}`)
  } finally {
    await close(proxy)
    await close(upstream)
  }
})
