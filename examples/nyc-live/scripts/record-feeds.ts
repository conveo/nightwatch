// Save snapshots of the MTA's subway realtime feeds for recorded mode
// (#mode=recorded&t=…): each feed's protobuf as the MTA sent it, named by its time,
// which /api/mta/<feed>?t=… plays back (see server/routes/mta.ts).
//
//   node scripts/record-feeds.ts                          # one snapshot of each feed, into data/trains/
//   node scripts/record-feeds.ts --every 30 --minutes 60  # a recording: every 30 s for an hour
//   node scripts/record-feeds.ts --fixture                # also public/fixtures/trains/ (trips that stop in AREA)
//   node scripts/record-feeds.ts --feed nqrw --feed l     # only these feeds
//
// The feeds recorded are those of the lines in data/subway.json (written by
// scripts/fetch-subway.ts), or in the subway fixture when that is missing. The feeds
// are published under the MTA's terms (see README.md); recordings stay in data/, which
// is not committed. The fixture keeps one small snapshot per feed.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import GtfsRealtimeBindings from "gtfs-realtime-bindings"
import { FEEDS, feedsFor } from "../src/layers/trains.ts"
import { stationId, type SubwayData } from "../src/layers/subway.ts"
import { fetchFeed, FIXTURES_DIR, RECORDINGS_DIR, snapshotName } from "../server/routes/mta.ts"

const { transit_realtime } = GtfsRealtimeBindings

// Only the trips that stop at one of `stations`, and no vehicle positions or alerts
// (the trains layer reads trip updates only), so a committed sample stays small. The
// result is still a feed the MTA could have sent, header and all.
export function trimFeed(buffer: Uint8Array, stations: Set<string>): Uint8Array {
  const message = transit_realtime.FeedMessage.decode(buffer)
  const entity = message.entity.filter((e) =>
    (e.tripUpdate?.stopTimeUpdate ?? []).some((u) => u.stopId != null && stations.has(stationId(u.stopId))),
  )
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

async function snapshot(feeds: string[], stations: Set<string> | null): Promise<void> {
  mkdirSync(RECORDINGS_DIR, { recursive: true })
  for (const feed of feeds) {
    try {
      const buffer = await fetchFeed(feed)
      const name = snapshotName(feed, feedTimestamp(buffer))
      writeFileSync(join(RECORDINGS_DIR, name), buffer)
      let line = `data/trains/${name}: ${(buffer.length / 1024).toFixed(0)} KB`
      if (stations != null) {
        mkdirSync(FIXTURES_DIR, { recursive: true })
        for (const old of readdirSync(FIXTURES_DIR)) if (old.startsWith(`${feed}-`)) rmSync(join(FIXTURES_DIR, old))
        const trimmed = trimFeed(buffer, stations)
        writeFileSync(join(FIXTURES_DIR, name), trimmed)
        line += `, public/fixtures/trains/${name}: ${(trimmed.length / 1024).toFixed(0)} KB`
      }
      console.log(line)
    } catch (error) {
      // One feed down does not stop a recording of the others.
      console.error(`${feed}: ${(error as Error).message}`)
    }
  }
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
