// Save snapshots of the MTA's subway realtime feeds for recorded mode
// (#mode=recorded&t=…): one file per moment with each feed's protobuf as the MTA sent
// it, which /api/mta/<feed>?t=… plays back (see server/routes/mta.ts).
//
//   node scripts/record-feeds.ts                          # one snapshot, into data/trains/
//   node scripts/record-feeds.ts --every 30 --minutes 60  # a recording: every 30 s for an hour
//   node scripts/record-feeds.ts --fixture                # also public/fixtures/trains/, trimmed to AREA
//   node scripts/record-feeds.ts --feed nqrw --feed l     # only these feeds
//
// The feeds recorded are those of the lines in data/subway.json (written by
// scripts/fetch-subway.ts), or in the subway fixture when that is missing. The feeds
// are published under the MTA's terms (see README.md); recordings stay in data/, which
// is not committed. The fixture is one small snapshot, replaced by the next --fixture.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import GtfsRealtimeBindings from "gtfs-realtime-bindings"
import { FEEDS, feedsFor } from "../src/layers/trains.ts"
import { stationId, type SubwayData } from "../src/layers/subway.ts"
import { fetchFeed, FIXTURES_DIR, formatSnapshot, RECORDINGS_DIR, snapshotName, snapshotTime, type Snapshot } from "../server/routes/mta.ts"

const { transit_realtime } = GtfsRealtimeBindings

// Only the trips that stop at one of `stations`, each with its stops from the one
// before the first of those to the one after the last, and no vehicle positions or
// alerts, so a committed sample stays small. That is all the trains layer reads: where
// the train is among those stations, whether it still has a stop to make before them,
// and whether its trip ends at the last. The result is still a feed the MTA could have
// sent, header and all.
export function trimFeed(buffer: Uint8Array, stations: Set<string>): Uint8Array {
  const message = transit_realtime.FeedMessage.decode(buffer)
  const entity = message.entity.flatMap((e) => {
    const updates = e.tripUpdate?.stopTimeUpdate ?? []
    const inside = updates.flatMap((u, i) => (u.stopId != null && stations.has(stationId(u.stopId)) ? [i] : []))
    if (e.tripUpdate == null || inside.length === 0) return []
    const stopTimeUpdate = updates.slice(Math.max(inside[0]! - 1, 0), inside.at(-1)! + 2)
    return [{ ...e, tripUpdate: { ...e.tripUpdate, stopTimeUpdate } }]
  })
  return transit_realtime.FeedMessage.encode(transit_realtime.FeedMessage.create({ header: message.header, entity })).finish()
}

export function feedTimestamp(buffer: Uint8Array): number {
  return Number(transit_realtime.FeedMessage.decode(buffer).header.timestamp ?? 0)
}

const here = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))

function readSubway(): SubwayData {
  for (const path of ["data/subway.json", "public/fixtures/subway.json"]) {
    if (existsSync(here(path))) return JSON.parse(readFileSync(here(path), "utf8")) as SubwayData
  }
  throw new Error("no subway data; run scripts/fetch-subway.ts")
}

function write(dir: string, label: string, buffers: Map<string, Uint8Array>, newest: number): void {
  const snapshot: Snapshot = {
    time: new Date(newest * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    feeds: Object.fromEntries([...buffers].map(([feed, b]) => [feed, Buffer.from(b).toString("base64")])),
  }
  const text = formatSnapshot(snapshot)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, snapshotName(newest)), text)
  console.log(`${label}/${snapshotName(newest)}: ${buffers.size} feeds, ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`)
}

async function snapshot(feeds: string[], stations: Set<string> | null): Promise<void> {
  const buffers = new Map<string, Uint8Array>()
  for (const feed of feeds) {
    try {
      buffers.set(feed, await fetchFeed(feed))
    } catch (error) {
      // One feed down does not stop a recording of the others.
      console.error(`${feed}: ${(error as Error).message}`)
    }
  }
  if (buffers.size === 0) return
  const newest = Math.max(...[...buffers.values()].map(feedTimestamp))
  write(RECORDINGS_DIR, "data/trains", buffers, newest)
  if (stations == null) return
  // The fixture is one snapshot: the new one replaces the old.
  if (existsSync(FIXTURES_DIR)) {
    for (const old of readdirSync(FIXTURES_DIR)) if (snapshotTime(old) != null) rmSync(join(FIXTURES_DIR, old))
  }
  const trimmed = new Map([...buffers].map(([feed, b]) => [feed, trimFeed(b, stations)]))
  write(FIXTURES_DIR, "public/fixtures/trains", trimmed, newest)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      feed: { type: "string", multiple: true },
      every: { type: "string" },
      minutes: { type: "string", default: "60" },
      fixture: { type: "boolean", default: false },
    },
  })
  const subway = readSubway()
  const feeds = values.feed ?? feedsFor(subway.routes.map((r) => r.id))
  const unknown = feeds.filter((f) => !Object.hasOwn(FEEDS, f))
  if (unknown.length > 0) throw new Error(`unknown feed ${unknown.join(", ")}; one of ${Object.keys(FEEDS).join(", ")}`)
  const stations = values.fixture ? new Set(subway.stops.map((s) => s.id)) : null

  await snapshot(feeds, stations)
  if (values.every == null) return
  const everyMs = Number(values.every) * 1000
  const until = Date.now() + Number(values.minutes) * 60_000
  if (!(everyMs > 0)) throw new Error(`--every needs a number of seconds, not "${values.every}"`)
  while (Date.now() + everyMs <= until) {
    await new Promise((resolve) => setTimeout(resolve, everyMs))
    await snapshot(feeds, null)
  }
}

if (import.meta.main) await main()
