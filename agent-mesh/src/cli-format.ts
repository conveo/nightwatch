// Line formats the CLI prints for values that other mesh participants wrote.
//
// Message fields arrive from the shared broker, and any client holding broker
// credentials can XADD an entry directly, skipping publish's schema. A raw
// newline in `from` or `correlationId` would print a second, forged
// `<id>  <from> -> <type>` line (an agent reading its inbox cannot tell it
// from a real message), and terminal escape sequences would reach the
// operator's terminal. Every such field is printed through `printable`.
// Bodies are already safe: they print as JSON.

import type { AgentRecord, MeshMessage } from "./types.js"

// C0 controls, DEL, C1 controls, and the Unicode line/paragraph separators.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

export function printable(value: string): string {
  return value.replace(UNPRINTABLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

export function formatInboxLine(m: MeshMessage): string {
  const corr = m.correlationId != null ? ` [${printable(m.correlationId)}]` : ""
  return `${printable(m.id)}  ${printable(m.from)} -> ${printable(m.type)}${corr}: ${JSON.stringify(m.body)}`
}

export function formatAgentLine(a: AgentRecord): string {
  return `${printable(a.id).padEnd(20)} ${printable(a.role).padEnd(14)} ${printable(a.status).padEnd(7)} host=${a.host != null ? printable(a.host) : "?"}`
}
