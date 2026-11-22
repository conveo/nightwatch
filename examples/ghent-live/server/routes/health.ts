import { sendJson, type Route } from "../api.ts"

// GET /api/health: the routes are mounted and the server answers. Also an example
// of the shape every route file has.
const route: Route = {
  method: "GET",
  path: "/api/health",
  handle(_req, res) {
    sendJson(res, 200, { ok: true })
  },
}

export default route
