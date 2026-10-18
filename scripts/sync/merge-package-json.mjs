// Merge a package.json copied from the monorepo with the fields this repo owns.
//
//   node scripts/sync/merge-package-json.mjs <staged> <current-or-missing> '<defaults-json>'
//
// <staged> is rewritten in place. Fields named in `owned` keep the value from
// <current> (this repo's file) when it has one, else take the default. So a
// rename is a one-line edit of "name" in this repo; the next sync keeps it.
// `scripts` in the defaults are added only when the staged file lacks them.
import { existsSync, readFileSync, writeFileSync } from "node:fs"

const [stagedPath, currentPath, defaultsJson] = process.argv.slice(2)
if (stagedPath == null || currentPath == null || defaultsJson == null) {
  console.error("usage: merge-package-json.mjs <staged> <current> '<defaults-json>'")
  process.exit(2)
}

const staged = JSON.parse(readFileSync(stagedPath, "utf8"))
const current = existsSync(currentPath) ? JSON.parse(readFileSync(currentPath, "utf8")) : {}
const defaults = JSON.parse(defaultsJson)
const owned = ["name", "private", "license"]

const merged = {}
for (const key of owned) {
  const value = current[key] ?? defaults[key]
  if (value !== undefined) merged[key] = value
}
for (const [key, value] of Object.entries(staged)) {
  if (!owned.includes(key)) merged[key] = value
}
if (defaults.scripts != null) {
  merged.scripts = { ...(merged.scripts ?? {}) }
  for (const [name, command] of Object.entries(defaults.scripts)) {
    if (!(name in merged.scripts)) merged.scripts[name] = command
  }
}

writeFileSync(stagedPath, `${JSON.stringify(merged, null, 2)}\n`)
