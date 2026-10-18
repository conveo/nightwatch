// Request validation at the two console routes whose input goes straight to a model.
//
// The cases that matter are the ones where the ARRAY is fine and an ELEMENT is not:
// checking the container and casting its contents lets any element reach the model's
// context as if it were the type the cast names.
//
// None of these reaches the network: every one is refused before the model is called,
// which is exactly the property being tested. A dummy key gets past the "no API key"
// gate that runs first.

import assert from "node:assert/strict"
import type { ServerResponse } from "node:http"
import { handleChat, handleNarrate } from "../console-routes.js"

type Captured = { status: number; body: string }

/** The two methods a refusing handler calls. Anything else would mean it got further. */
function fakeResponse(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: "" }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return res
    },
    end(body?: unknown) {
      captured.body = body == null ? "" : String(body)
      return res
    },
  }
  return { res: res as unknown as ServerResponse, captured }
}

const validMesh = {
  id: "1-0",
  ts: "2026-09-23T07:00:00Z",
  from: "worker",
  to: "operator",
  type: "result",
  body: { text: "done" },
  correlationId: null,
  replyTo: null,
  channel: "mesh:inbox:operator",
}

export async function runConsoleBoundariesTest(): Promise<number> {
  let failures = 0
  const check = async (name: string, test: () => Promise<void>) => {
    try {
      await test()
      console.log(`  [PASS] ${name}`)
    } catch (error) {
      failures++
      console.error(`  [FAIL] ${name}`, error)
    }
  }

  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = "test-key-never-sent"

  console.log("\n[console] request boundaries")

  await check("narration refuses an array whose ELEMENT is not a mesh message", async () => {
    // The array is real; one message in it is missing `from` and has an invented type.
    const { res, captured } = fakeResponse()
    const bad = { ...validMesh, from: undefined, type: "shout" }
    await handleNarrate({ res, rawBody: JSON.stringify({ messages: [validMesh, bad] }) })
    assert.equal(captured.status, 400)
    assert.match(captured.body, /mesh messages/)
  })

  await check("narration still refuses an empty batch, with the reason that applies", async () => {
    const { res, captured } = fakeResponse()
    await handleNarrate({ res, rawBody: JSON.stringify({ messages: [] }) })
    assert.equal(captured.status, 400)
    assert.match(captured.body, /nothing to narrate/)
  })

  await check("chat refuses a transcript that is not UI messages", async () => {
    const { res, captured } = fakeResponse()
    await handleChat({ res, rawBody: JSON.stringify({ messages: [{ id: "m1", role: "assistant", parts: [{ type: "text" }] }] }) })
    // A text part with no text is the realistic shape of a client-side bug.
    assert.equal(captured.status, 400)
    assert.match(captured.body, /not valid UI messages/)
  })

  await check("chat refuses a transcript whose role is not a UIMessage role", async () => {
    const { res, captured } = fakeResponse()
    await handleChat({ res, rawBody: JSON.stringify({ messages: [{ id: "m1", role: "worker", parts: [{ type: "text", text: "hi" }] }] }) })
    // An agent id smuggled into `role` is the mistake the transcript schema was built
    // to prevent — WHO said it lives in `author`, never in the SDK's role union.
    assert.equal(captured.status, 400)
  })

  if (previousKey == null) {
    delete process.env.OPENAI_API_KEY
  } else {
    process.env.OPENAI_API_KEY = previousKey
  }
  return failures
}
