// Server routes for the dev and preview servers. Every file in server/routes/ that
// default-exports a Route (or an array of them) is mounted, so tickets add routes
// without editing vite.config.ts. Routes run in Node: they can hold API keys and
// fetch feeds that must not be fetched from the browser.

import type { IncomingMessage, ServerResponse } from "node:http"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Connect, Plugin } from "vite"

export type Route = {
  method: "GET" | "POST"
  // An exact path ("/api/health"), or a prefix ending in "/*" ("/api/mta/*").
  path: string
  handle(req: IncomingMessage, res: ServerResponse, url: URL): void | Promise<void>
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.setHeader("Cache-Control", "no-store")
  res.end(JSON.stringify(body))
}

export async function readJson<T>(req: IncomingMessage, limitBytes = 64 * 1024): Promise<T> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limitBytes) throw new Error("request body too large")
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T
}

export async function loadRoutes(dir: string): Promise<Route[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort()
  const routes: Route[] = []
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: Route | Route[] }
    if (mod.default == null) throw new Error(`server/routes/${file} has no default export`)
    routes.push(...(Array.isArray(mod.default) ? mod.default : [mod.default]))
  }
  return routes
}

function matches(route: Route, method: string | undefined, pathname: string): boolean {
  if (route.method !== method) return false
  return route.path.endsWith("/*") ? pathname.startsWith(route.path.slice(0, -1)) : pathname === route.path
}

export function routesMiddleware(routes: Route[]): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const route = routes.find((r) => matches(r, req.method, url.pathname))
    if (route == null) return next()
    // An async wrapper, so a handler that throws before its first await is caught too.
    ;(async () => route.handle(req, res, url))().catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message })
      else res.end()
    })
  }
}

export function apiPlugin(routes: Route[]): Plugin {
  const middleware = routesMiddleware(routes)
  return {
    name: "nyc-live-api",
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
