// Record the parking garages' occupancy for recorded mode (`mode=recorded&t=…`).
//
//   node scripts/record-parking.ts                       # one snapshot, now
//   node scripts/record-parking.ts --every 10 --count 6  # six snapshots, ten minutes apart
//   node scripts/record-parking.ts --fixture             # rewrite public/fixtures/parking.json
//
// Reads Stad Gent's feed directly (no dev server needed), parses it as /api/parking
// does, and adds the snapshot to public/fixtures/parking/snapshots.json under the
// time it was read. The file keeps the newest `--keep` snapshots (default 48), so it
// stays a small fixture. The parking layer reads the snapshot nearest to `t`.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs } from "node:util"
import type { GarageState } from "../server/city-state.ts"
import { FEED_URL, parseFeed, type ParkingSnapshot, type SnapshotFile } from "../server/routes/parking.ts"

async function read(): Promise<ParkingSnapshot> {
  const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`parking feed answered ${res.status}`)
  return { time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), garages: parseFeed(await res.json()) }
}

// One garage per line, so a new snapshot reads as a small diff.
function garageLines(garages: GarageState[], indent: string): string {
  return garages.map((g) => indent + JSON.stringify(g)).join(",\n")
}

export function formatSnapshots(file: SnapshotFile): string {
  const entries = Object.entries(file.snapshots).sort(([a], [b]) => Date.parse(a) - Date.parse(b))
  const body = entries.map(([t, gs]) => `    ${JSON.stringify(t)}: [\n${garageLines(gs, "      ")}\n    ]`).join(",\n")
  return `{\n  "snapshots": {\n${body}\n  }\n}\n`
}

export function formatFixture(snapshot: ParkingSnapshot): string {
  return `{\n  "time": ${JSON.stringify(snapshot.time)},\n  "garages": [\n${garageLines(snapshot.garages, "    ")}\n  ]\n}\n`
}

export function addSnapshot(file: SnapshotFile, snapshot: ParkingSnapshot, keep: number): SnapshotFile {
  const all = { ...file.snapshots, [snapshot.time]: snapshot.garages }
  const newest = Object.keys(all)
    .sort((a, b) => Date.parse(b) - Date.parse(a))
    .slice(0, Math.max(1, keep))
  return { snapshots: Object.fromEntries(newest.map((t) => [t, all[t]!])) }
}

// The recordings so far. Only a missing file starts empty: a file that does not
// parse stops the recording, so its history is never replaced by one snapshot.
export function loadSnapshots(path: string): SnapshotFile {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { snapshots: {} }
    throw error
  }
  const parsed = JSON.parse(text) as Partial<SnapshotFile> | null
  if (parsed?.snapshots == null || typeof parsed.snapshots !== "object" || Array.isArray(parsed.snapshots)) {
    throw new Error(`${path}: no "snapshots" object`)
  }
  return parsed as SnapshotFile
}

// Written next to the file and renamed over it, so an interrupted write never
// leaves half a file.
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: "public/fixtures/parking/snapshots.json" },
      keep: { type: "string", default: "48" },
      every: { type: "string", default: "10" },
      count: { type: "string", default: "1" },
      fixture: { type: "boolean", default: false },
    },
  })
  const count = Math.max(1, Number(values.count) || 1)
  const everyMs = Math.max(1, Number(values.every) || 10) * 60_000
  for (let i = 0; i < count; i++) {
    if (i > 0) await sleep(everyMs)
    let snapshot: ParkingSnapshot
    try {
      snapshot = await read()
    } catch (error) {
      // One failed read does not end a long recording; the exit code reports it.
      console.error(`snapshot ${i + 1} of ${count} failed: ${(error as Error).message}`)
      process.exitCode = 1
      continue
    }
    if (values.fixture) {
      writeAtomic("public/fixtures/parking.json", formatFixture(snapshot))
      console.log(`public/fixtures/parking.json: ${snapshot.garages.length} garages at ${snapshot.time}`)
      continue
    }
    const file = addSnapshot(loadSnapshots(values.out), snapshot, Number(values.keep) || 48)
    writeAtomic(values.out, formatSnapshots(file))
    console.log(`${values.out}: ${snapshot.garages.length} garages at ${snapshot.time} (${Object.keys(file.snapshots).length} snapshots)`)
  }
}
