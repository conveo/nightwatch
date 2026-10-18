import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { loadRoutes, routesMiddleware, type Route } from "../server/api.ts"

async function serve(routes: Route[]) {
  const middleware = routesMiddleware(routes)
  const server = createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 404
      res.end("not a route")
    }),
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // fetch keeps connections alive; close them, or close() waits for them forever.
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return { base, close }
}

test("every file in server/routes is mounted", async () => {
  const routes = await loadRoutes(new URL("../server/routes", import.meta.url).pathname)
  assert.ok(routes.some((r) => r.path === "/api/health"))
  const { base, close } = await serve(routes)
  try {
    const res = await fetch(`${base}/api/health`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.equal((await fetch(`${base}/api/nothing`)).status, 404)
  } finally {
    await close()
  }
})

test("prefix routes match below their path, and errors become a 500", async () => {
  const routes: Route[] = [
    {
      method: "GET",
      path: "/api/feed/*",
      handle(_req, res, url) {
        res.end(url.pathname)
      },
    },
    {
      method: "GET",
      path: "/api/boom",
      handle() {
        throw new Error("boom")
      },
    },
  ]
  const { base, close } = await serve(routes)
  try {
    assert.equal(await (await fetch(`${base}/api/feed/ace`)).text(), "/api/feed/ace")
    const boom = await fetch(`${base}/api/boom`)
    assert.equal(boom.status, 500)
    assert.deepEqual(await boom.json(), { error: "boom" })
  } finally {
    await close()
  }
})
