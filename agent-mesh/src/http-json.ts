import type { ServerResponse } from "node:http"
import { securityHeaders } from "./ui-guards.js"

// Its own module rather than living in ui-server.ts, because ui-server.ts creates and
// binds the server at the top level — importing it from a route module would start one.
export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { ...securityHeaders("api"), "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}
