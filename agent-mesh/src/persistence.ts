import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export function syncParentDirectory(path: string): void {
  const directory = openSync(dirname(path), "r")
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

export function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`
  const fd = openSync(temporary, "w", 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  syncParentDirectory(path)
}
