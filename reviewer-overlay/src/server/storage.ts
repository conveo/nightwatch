import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

export type ReportFiles = {
  id: string
  jsonPath: string
  pngPath: string
}

// Names come only from the server clock and a random UUID. Nothing from the
// request reaches a path, so a crafted `capturedAt` or url cannot pick where a
// file lands.
export function newReportFiles(args: { dir: string; now: Date }): ReportFiles {
  const stamp = args.now.toISOString().replace(/[^0-9]/g, "").slice(0, 17)
  const id = `review-${stamp}-${randomUUID()}`
  const dir = resolve(args.dir)
  const files = {
    id,
    jsonPath: join(dir, `${id}.json`),
    pngPath: join(dir, `${id}.png`),
  }
  for (const path of [files.jsonPath, files.pngPath]) {
    if (!path.startsWith(dir + sep)) {
      throw new Error("report path escaped the report directory")
    }
  }
  return files
}

export async function ensureReportDir(dir: string): Promise<void> {
  await mkdir(resolve(dir), { recursive: true, mode: 0o700 })
}

// `wx` refuses to overwrite, so a name collision fails instead of replacing a
// report.
export async function writeNewFile(args: {
  path: string
  data: Buffer | string
}): Promise<void> {
  await writeFile(args.path, args.data, { flag: "wx", mode: 0o600 })
}

export async function overwriteFile(args: {
  path: string
  data: string
}): Promise<void> {
  await writeFile(args.path, args.data, { flag: "w", mode: 0o600 })
}
