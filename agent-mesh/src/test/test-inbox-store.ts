import assert from "node:assert/strict"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendToInbox, ensureHome, getAgentState, inboxFile, readInboxLines, readUnread, removeLocalAgent } from "../local-store.js"
import type { MeshMessage } from "../types.js"

const message = (id: string): MeshMessage => ({
  id,
  ts: "2026-09-07T00:00:00Z",
  from: "sender",
  to: "recipient",
  channel: "mesh:inbox:recipient",
  type: "request",
  body: { text: `selected text ${id} — café`, image: "s3-key" },
  correlationId: "thread",
  replyTo: "parent",
})
const line = (id: string) => `${JSON.stringify(message(id))}\n`

export function runInboxStoreTest(): number {
  const home = fs.mkdtempSync(join(tmpdir(), "mesh-inbox-store-"))
  const previousHome = process.env.AGENT_MESH_HOME
  process.env.AGENT_MESH_HOME = home
  let failures = 0
  const check = (name: string, test: () => void) => {
    try {
      test()
      console.log(`  [PASS] ${name}`)
    } catch (error) {
      failures++
      console.error(`  [FAIL] ${name}`, error)
    }
  }
  try {
    ensureHome()
    check("partial tail preserves complete mail and cursors until broker replay", () => {
      const path = join(home, "inbox", "partial.jsonl")
      const prefix = line("1") + line("2")
      const interrupted = prefix + '{"id":"3","body":{"text":"caf'
      fs.writeFileSync(path, interrupted)
      assert.deepEqual(readUnread("partial", { peek: true }), [message("1"), message("2")])
      assert.equal(fs.readFileSync(path, "utf8"), interrupted, "read-only inspection must not repair the file")
      readUnread("partial", { peek: false })
      const state = getAgentState("partial")
      appendToInbox("partial", message("3"))
      appendToInbox("partial", message("3"))
      assert.equal(fs.readFileSync(path, "utf8"), prefix + line("3"))
      assert.deepEqual(readUnread("partial", { peek: true }), [message("3")])
      assert.deepEqual(getAgentState("partial"), state)
    })
    check("valid final record without newline is preserved", () => {
      const path = join(home, "inbox", "unterminated.jsonl")
      fs.writeFileSync(path, JSON.stringify(message("1")))
      appendToInbox("unterminated", message("1"))
      appendToInbox("unterminated", message("2"))
      assert.equal(fs.readFileSync(path, "utf8"), line("1") + line("2"))
    })
    check("malformed complete records remain visible errors without truncation", () => {
      const path = join(home, "inbox", "corrupt.jsonl")
      const data = line("1") + '{"broken":\n' + line("2")
      fs.writeFileSync(path, data)
      assert.throws(() => readInboxLines("corrupt"))
      assert.throws(() => appendToInbox("corrupt", message("3")))
      assert.equal(fs.readFileSync(path, "utf8"), data)
    })
    check("retained inbox appends and peeks avoid repeated full-file reads", () => {
      const path = join(home, "inbox", "cached.jsonl")
      fs.writeFileSync(path, Array.from({ length: 500 }, (_, i) => line(String(i))).join(""))
      const originalRead = fs.readFileSync
      let reads = 0
      try {
        fs.readFileSync = new Proxy(originalRead, {
          apply(target, thisArg, args) {
            if (String(args[0]) === path) reads++
            return Reflect.apply(target, thisArg, args)
          },
        })
        syncBuiltinESMExports()
        for (let i = 500; i < 520; i++) {
          appendToInbox("cached", message(String(i)))
          appendToInbox("cached", message(String(i)))
          assert.equal(readInboxLines("cached").length, i + 1)
        }
        assert.equal(reads, 1)
      } finally {
        fs.readFileSync = originalRead
        syncBuiltinESMExports()
      }
      const replacement = path + ".replacement"
      fs.writeFileSync(replacement, line("x"))
      fs.renameSync(replacement, path)
      assert.deepEqual(readInboxLines("cached"), [message("x")])
      fs.writeFileSync(path, line("y"))
      assert.deepEqual(readInboxLines("cached"), [message("y")])
      fs.unlinkSync(path)
      assert.deepEqual(readInboxLines("cached"), [])
      appendToInbox("cached", message("500"))
      assert.deepEqual(readInboxLines("cached"), [message("500")])
    })
    check("an id outside the agent-id charset never becomes an inbox path", () => {
      const outside = join(home, "escaped.jsonl")
      for (const id of ["../escaped", "a/b", "/etc/passwd", "../", "", "x\ny", "has space"]) {
        assert.throws(() => inboxFile(id), /invalid agent id/, `inboxFile(${JSON.stringify(id)})`)
        assert.throws(() => appendToInbox(id, message("1")), /invalid agent id/)
        assert.throws(() => readInboxLines(id), /invalid agent id/)
        assert.throws(() => readUnread(id, { peek: true }), /invalid agent id/)
        assert.throws(() => removeLocalAgent(id), /invalid agent id/)
      }
      assert.equal(fs.existsSync(outside), false)
      assert.equal(inboxFile("worker-a.v2_x"), join(home, "inbox", "worker-a.v2_x.jsonl"))
      // Dots are in the charset, but with the suffix they still name one file
      // inside the inbox directory, never its parent.
      assert.equal(inboxFile(".."), join(home, "inbox", "...jsonl"))
    })
  } finally {
    if (previousHome == null) delete process.env.AGENT_MESH_HOME
    else process.env.AGENT_MESH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
  return failures
}

if (process.argv[1]?.endsWith("test-inbox-store.ts")) process.exitCode = runInboxStoreTest() > 0 ? 1 : 0
