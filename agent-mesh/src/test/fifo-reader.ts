// A stand-in for "a running Claude process" that receives DIRECT injection from
// the daemon over a named pipe. Opens the fifo O_RDWR (so it always counts as a
// reader — avoids the nonblocking-writer ENXIO race) and prints each pushed line
// with an [injected] marker. Used by demo.sh.
//
//   tsx src/test/fifo-reader.ts <fifo-path> <label>

import { openSync, createReadStream } from "node:fs"
import { constants } from "node:fs"

const fifoPath = process.argv[2]
const label = process.argv[3] ?? "agent"
if (fifoPath == null) {
  process.stderr.write("usage: fifo-reader <fifo-path> [label]\n")
  process.exit(1)
}

const fd = openSync(fifoPath, constants.O_RDWR) // O_RDWR keeps the pipe open across writers
const stream = createReadStream("", { fd })
let buf = ""
stream.on("data", (chunk) => {
  buf += chunk.toString()
  const lines = buf.split("\n")
  buf = lines.pop() ?? ""
  for (const line of lines) {
    if (line.trim() === "") {
      continue
    }
    const m = JSON.parse(line) as { from: string; type: string; body: unknown }
    process.stdout.write(`  [${label} <- injected via fifo] ${m.from} ${m.type}: ${JSON.stringify(m.body)}\n`)
  }
})
