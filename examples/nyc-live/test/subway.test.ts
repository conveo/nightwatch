import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { test } from "node:test"
import { deflateRawSync } from "node:zlib"
import { Raycaster, Vector3, type Mesh, type MeshStandardMaterial } from "three"
import {
  buildSubwayData,
  clipLine,
  dropBacktracks,
  parseColor,
  parseCsv,
  parseRoutes,
  parseShapes,
  readFeed,
  readZipEntry,
} from "../scripts/fetch-subway.ts"
import { SUBWAY_DEPTH_M } from "../src/constants.ts"
import { toLatLon, toLocal, VENUE } from "../src/geo.ts"
import {
  createSubwayLayer,
  distinctLines,
  pointAlong,
  project,
  stationId,
  toPath,
  tubeGeometry,
  TUBE_RADIUS_M,
  type SubwayData,
} from "../src/layers/subway.ts"

const FIXTURE = "public/fixtures/subway.json"
const fixture = () => JSON.parse(readFileSync(FIXTURE, "utf8")) as SubwayData
const ctx = { mode: "fixture" as const, time: null }

// [lat, lon] for a point `x` metres east and `z` metres south of the venue.
const at = (x: number, z: number): [number, number] => {
  const p = toLatLon({ x, z })
  return [p.lat, p.lon]
}

test("the CSV reader handles quotes, commas, CRLF, a BOM and blank lines", () => {
  const text = '﻿route_id,route_desc,route_color\r\nA,"Inwood, Manhattan ""8 Av""",0062CF\r\n\r\nB,,\n'
  assert.deepEqual(parseCsv(text), [
    { route_id: "A", route_desc: 'Inwood, Manhattan "8 Av"', route_color: "0062CF" },
    { route_id: "B", route_desc: "", route_color: "" },
  ])
})

test("route colours become #RRGGBB, with GTFS's white and black when missing", () => {
  assert.equal(parseColor("f6bc26", "#FFFFFF"), "#F6BC26")
  assert.equal(parseColor(" #0062CF ", "#FFFFFF"), "#0062CF")
  assert.equal(parseColor("", "#FFFFFF"), "#FFFFFF")
  assert.equal(parseColor("yellow", "#FFFFFF"), "#FFFFFF")
  const routes = parseRoutes(
    "route_id,route_short_name,route_color,route_text_color\nN,N,F6BC26,000000\nGS,S,,\nX9,,12345,\n",
  )
  assert.deepEqual(routes, [
    { id: "N", name: "N", color: "#F6BC26", textColor: "#000000" },
    { id: "GS", name: "S", color: "#FFFFFF", textColor: "#000000" },
    { id: "X9", name: "X9", color: "#FFFFFF", textColor: "#000000" },
  ])
})

test("shape points are ordered by shape_pt_sequence, not file order", () => {
  const shapes = parseShapes(
    "shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon\nN..N20R,2,40.3,-74.3\nN..N20R,0,40.1,-74.1\nR..N93R,0,41,-73\nN..N20R,1,40.2,-74.2\n",
  )
  assert.deepEqual(shapes.get("N..N20R"), [
    { lat: 40.1, lon: -74.1 },
    { lat: 40.2, lon: -74.2 },
    { lat: 40.3, lon: -74.3 },
  ])
  assert.equal(shapes.get("R..N93R")?.length, 1)
})

test("a line leaving the region is cut where it crosses the boundary", () => {
  const inside = (p: { lat: number; lon: number }) => p.lat <= 40.5
  const clipped = clipLine(
    [
      { lat: 40.0, lon: -74 },
      { lat: 40.4, lon: -74 },
      { lat: 40.6, lon: -74 },
      { lat: 40.8, lon: -74 },
    ],
    inside,
  )
  assert.equal(clipped.length, 3)
  assert.ok(Math.abs(clipped[2]!.lat - 40.5) < 1e-6)
  assert.deepEqual(clipLine([{ lat: 41, lon: -74 }], inside), [])
})

test("a shape's out-and-back excursion is dropped, the rest kept", () => {
  const p = (lat: number) => ({ lat, lon: -74 })
  // A B C D C B E: out to D and back to B, then on to E.
  assert.deepEqual(dropBacktracks([p(1), p(2), p(3), p(4), p(3), p(2), p(5)]), [p(1), p(2), p(5)])
  assert.deepEqual(dropBacktracks([p(1), p(2), p(3)]), [p(1), p(2), p(3)])
})

// A tiny feed: the N runs north under the venue, then a shape whose id names the 6
// but whose trips are the 6X, and a station outside the region.
function tinyFeed(): Record<string, string> {
  const shapePoints = (id: string, points: Array<[number, number]>) =>
    points.map(([lat, lon], i) => `${id},${i},${lat},${lon}`).join("\n")
  const [s1, s2, s3] = [at(0, 300), at(0, 0), at(0, -300)]
  const [l1, l2] = [at(200, 300), at(200, -300)]
  const far = at(0, -5000)
  return {
    "feed_info.txt": "feed_publisher_name,feed_version,feed_start_date,feed_end_date\nMTA,v1,20260101,20261231\n",
    "routes.txt":
      "route_id,route_short_name,route_color,route_text_color\nN,N,F6BC26,000000\n6,6,009952,FFFFFF\n6X,6X,009952,FFFFFF\n",
    "shapes.txt":
      "shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon\n" +
      shapePoints("N..N20R", [s1, s2, s3, far]) +
      "\n" +
      shapePoints("6..N02R", [l1, l2]) +
      "\n",
    "stops.txt":
      "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n" +
      `R22,Prince St,${s2.join(",")},1,\nR22N,Prince St,${s2.join(",")},,R22\n` +
      `R21,8 St-NYU,${s3.join(",")},1,\nR21N,8 St-NYU,${s3.join(",")},,R21\n` +
      `R20,14 St-Union Sq,${far.join(",")},1,\nR20N,14 St-Union Sq,${far.join(",")},,R20\n` +
      `637,Bleecker St,${l2.join(",")},1,\n637N,Bleecker St,${l2.join(",")},,637\n`,
    "trips.txt": "route_id,trip_id,service_id,shape_id\nN,t1,Weekday,N..N20R\n6X,t2,Weekday,6..N02R\n6X,t3,Weekday,6..N02R\n",
    "stop_times.txt":
      "trip_id,stop_id,arrival_time,departure_time,stop_sequence\n" +
      "t1,R22N,08:00:00,08:00:00,1\nt1,R21N,08:02:00,08:02:00,2\nt1,R20N,08:04:00,08:04:00,3\n" +
      "t2,637N,08:00:00,08:00:00,1\n",
  }
}

test("a feed becomes routes, shapes with their stations, and stations with their routes", () => {
  const files = tinyFeed()
  const feed = readFeed((name) => files[name] ?? assert.fail(`no ${name}`))
  const near = (p: { lat: number; lon: number }) => Math.hypot(toLocal(p).x, toLocal(p).z) <= 1000
  const data = buildSubwayData(feed, near, { radiusM: 1000 })

  assert.deepEqual(data.feed, { publisher: "MTA", version: "v1", start: "20260101", end: "20261231" })
  // Only routes with a shape in the region; the 6 has none (its shape is the 6X's).
  assert.deepEqual(
    data.routes.map((r) => [r.id, r.color]),
    [
      ["N", "#F6BC26"],
      ["6X", "#009952"],
    ],
  )
  const n = data.shapes.find((s) => s.id === "N..N20R")!
  assert.equal(n.route, "N")
  // Clipped 1 km from the venue: three points inside plus the crossing.
  assert.equal(n.points.length, 4)
  assert.ok(Math.abs(Math.hypot(toLocal({ lat: n.points[3]![0], lon: n.points[3]![1] }).z) - 1000) < 0.5)
  // R20 lies outside the region, so the shape lists only the two stations inside, in order.
  assert.deepEqual(
    n.stops.map((s) => s.id),
    ["R22", "R21"],
  )
  assert.ok(Math.abs(n.stops[0]!.d - 300) < 0.5 && Math.abs(n.stops[1]!.d - 600) < 0.5)
  assert.equal(data.shapes.find((s) => s.id === "6..N02R")!.route, "6X")
  assert.deepEqual(
    data.stops.map((s) => [s.id, s.routes]),
    [
      ["637", ["6X"]],
      ["R21", ["N"]],
      ["R22", ["N"]],
    ],
  )
})

test("the zip reader inflates one entry from a zip", () => {
  const entries = [
    { name: "agency.txt", data: Buffer.from("agency_id\nMTA NYCT\n") },
    { name: "routes.txt", data: Buffer.from("route_id\nN\n".repeat(50)) },
  ]
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const packed = deflateRawSync(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    const record = Buffer.concat([local, Buffer.from(name), packed])
    locals.push(record)
    centrals.push(Buffer.concat([central, Buffer.from(name)]))
    offset += record.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  const zip = Buffer.concat([...locals, directory, end])

  assert.equal(readZipEntry(zip, "routes.txt").toString(), "route_id\nN\n".repeat(50))
  assert.equal(readZipEntry(zip, "agency.txt").toString(), "agency_id\nMTA NYCT\n")
  assert.throws(() => readZipEntry(zip, "shapes.txt"), /not in the feed/)
  assert.throws(() => readZipEntry(Buffer.from("not a zip at all, just some text"), "x"), /not a zip/)
})

test("realtime platform ids map to their station", () => {
  assert.equal(stationId("R22N"), "R22")
  assert.equal(stationId("637S"), "637")
  assert.equal(stationId("R22"), "R22")
  assert.equal(stationId("S01"), "S01")
})

test("pointAlong and project walk a path in metres and invert each other", () => {
  const path = toPath([at(0, 0), at(0, -100), at(100, -100)])
  assert.ok(Math.abs(path.length - 200) < 0.01)
  const mid = pointAlong(path, 150)
  assert.ok(Math.abs(mid.x - 50) < 0.01 && Math.abs(mid.z + 100) < 0.01)
  assert.ok(Math.abs(mid.dir.x - 1) < 1e-6 && Math.abs(mid.dir.z) < 1e-6)
  // North is -z, so the first leg heads (0, -1).
  assert.ok(Math.abs(pointAlong(path, 10).dir.z + 1) < 1e-6)
  // Clamped to the ends.
  assert.ok(Math.abs(pointAlong(path, -5).z) < 0.01)
  assert.ok(Math.abs(pointAlong(path, 999).x - 100) < 0.01)
  for (const d of [0, 37.5, 100, 160, 200]) assert.ok(Math.abs(project(path, pointAlong(path, d)).d - d) < 0.01)
  const off = project(path, { x: 20, z: -40 })
  assert.ok(Math.abs(off.d - 40) < 0.01 && Math.abs(off.offset - 20) < 0.01)
})

test("a tube follows its line at the given depth, one ring per point, faces outward", () => {
  const line = [
    { x: 0, z: 0 },
    { x: 0, z: -50 },
    { x: 50, z: -50 },
  ]
  const geometry = tubeGeometry([line], SUBWAY_DEPTH_M, 4, 8)
  const pos = geometry.getAttribute("position")
  const normal = geometry.getAttribute("normal")
  assert.equal(pos.count, 3 * 8)
  assert.equal(geometry.getIndex()!.count, 2 * 8 * 6)
  for (let i = 0; i < pos.count; i++) {
    assert.ok(Math.abs(pos.getY(i) - SUBWAY_DEPTH_M) <= 4 + 1e-6)
    const centre = line[Math.floor(i / 8)]!
    const out = new Vector3(pos.getX(i) - centre.x, pos.getY(i) - SUBWAY_DEPTH_M, pos.getZ(i) - centre.z)
    assert.ok(out.dot(new Vector3(normal.getX(i), normal.getY(i), normal.getZ(i))) > 0)
  }
  // Triangles wind counter-clockwise seen from outside.
  const index = geometry.getIndex()!
  const v = (k: number) => new Vector3(pos.getX(k), pos.getY(k), pos.getZ(k))
  for (let t = 0; t < index.count; t += 3) {
    const [a, b, c] = [v(index.getX(t)), v(index.getX(t + 1)), v(index.getX(t + 2))]
    const face = b.clone().sub(a).cross(c.clone().sub(a))
    const n = new Vector3(normal.getX(index.getX(t)), normal.getY(index.getX(t)), normal.getZ(index.getX(t)))
    assert.ok(face.dot(n) > 0, `triangle ${t / 3} faces inward`)
  }
})

test("a line of tiny steps still draws its whole length", () => {
  // 9 m in 1,000 steps of 9 mm: each step alone is under the 1 cm repeat threshold.
  const line = Array.from({ length: 1001 }, (_, i) => ({ x: 0, z: -i * 0.009 }))
  const pos = tubeGeometry([line], SUBWAY_DEPTH_M, 4, 8).getAttribute("position")
  let minZ = Infinity
  for (let i = 0; i < pos.count; i++) minZ = Math.min(minZ, pos.getZ(i))
  assert.ok(minZ < -8.9, `the tube stops at z=${minZ}`)
})

test("a route's repeated shapes are drawn once, its branches are kept", () => {
  const northbound = toPath([at(0, 400), at(0, -400)])
  const southbound = toPath([at(4, -400), at(4, 400)])
  const shortTurn = toPath([at(0, 200), at(0, -100)])
  const branch = toPath([at(0, 0), at(300, 300)])
  const drawn = distinctLines([shortTurn, southbound, branch, northbound])
  assert.equal(drawn.length, 2)
  assert.ok(drawn.includes(branch))
  assert.ok(drawn.includes(northbound) || drawn.includes(southbound))
})

test("the fixture is small and has the lines and stations beside the venue", () => {
  assert.ok(statSync(FIXTURE).size < 300 * 1024)
  const data = fixture()
  assert.deepEqual(data.clip, { radiusM: 400 })
  // Prince St, on the N/Q/R/W, is the venue's station.
  const prince = data.stops.find((s) => s.id === "R22")!
  assert.equal(prince.name, "Prince St")
  assert.ok(Math.hypot(toLocal(prince).x, toLocal(prince).z) < 150)
  for (const r of ["N", "R", "W"]) assert.ok(prince.routes.includes(r), r)
  const yellow = data.routes.filter((r) => r.color === "#F6BC26").map((r) => r.id)
  assert.deepEqual(yellow.sort(), ["N", "Q", "R", "W"])
  // A yellow line passes within 60 m of the venue (Broadway, right under it).
  const nearest = Math.min(
    ...data.shapes.filter((s) => yellow.includes(s.route)).map((s) => project(toPath(s.points), toLocal(VENUE)).offset),
  )
  assert.ok(nearest < 60, `nearest yellow line is ${nearest.toFixed(0)} m away`)
  // Every station a shape lists exists, and every shape's route is listed.
  const stops = new Set(data.stops.map((s) => s.id))
  const routes = new Set(data.routes.map((r) => r.id))
  for (const shape of data.shapes) {
    assert.ok(routes.has(shape.route), shape.id)
    for (const s of shape.stops) assert.ok(stops.has(s.id), `${shape.id} -> ${s.id}`)
  }
})

test("the layer draws each route in its colour below the street, and stations on top", async () => {
  const data = fixture()
  const layer = createSubwayLayer(async () => data)
  await layer.init(ctx)
  const lines = layer.group.children.filter((c) => c.name.startsWith("route:")) as Mesh[]
  assert.equal(lines.length, data.routes.length)
  for (const mesh of lines) {
    const route = data.routes.find((r) => `route:${r.id}` === mesh.name)!
    const material = mesh.material as MeshStandardMaterial
    assert.equal(`#${material.color.getHexString().toUpperCase()}`, route.color)
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox!
    assert.ok(box.min.y >= SUBWAY_DEPTH_M - TUBE_RADIUS_M - 1e-3 && box.max.y <= SUBWAY_DEPTH_M + TUBE_RADIUS_M + 1e-3)
  }
  assert.equal(layer.summary?.(), "11 subway lines · 4 stations")

  // Straight down onto Prince St picks the station, onto the Broadway line away from
  // any station picks a yellow route, and open ground picks nothing.
  const prince = toLocal(data.stops.find((s) => s.id === "R22")!)
  const down = (x: number, z: number) => new Raycaster(new Vector3(x, 500, z), new Vector3(0, -1, 0))
  layer.group.updateMatrixWorld(true)
  assert.equal(layer.pick?.(down(prince.x, prince.z)), "stop:R22")
  const broadway = pointAlong(toPath(data.shapes.find((s) => s.route === "R")!.points), 20)
  assert.match(layer.pick?.(down(broadway.x, broadway.z)) ?? "", /^route:[NQRW]$/)
  assert.equal(layer.pick?.(down(prince.x + 300, prince.z - 300)), null)

  layer.select?.("route:N")
  const material = (id: string) => (lines.find((m) => m.name === `route:${id}`)!.material as MeshStandardMaterial)
  assert.equal(material("N").opacity, 1)
  assert.ok(material("6").opacity < 1)
  layer.select?.(null)
  assert.equal(material("6").opacity, 1)
})

// test/fixtures/subway.png is the fixture view from above (#cam=0,1100,1&tgt=0,0,0),
// and test/recordings/ holds the Decisions API's real answers for it.
test("the recorded subway screenshot passes its checks", () => {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  const run = spawnSync(
    process.execPath,
    ["scripts/check-visual.ts", "test/fixtures/subway.png", "checks/subway.json", "--replay"],
    { encoding: "utf8", env },
  )
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.match(/^PASS /gm)?.length, 3, run.stdout)
})
