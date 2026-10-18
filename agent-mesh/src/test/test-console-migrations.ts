// The transcript store's self-applying migrations, against real scratch SQLite files.
//
// The case that matters is a database with the FIRST migration and not the second:
// the old probe ("does Conversation exist?") called that ready, and every write that
// touched `author` then failed with nothing ever retrying it. The pre-ledger cases
// model the databases every console has today, including one holding real messages
// that must survive untouched.

import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3"
import { applyMigrations } from "../console-db.js"
import { PrismaClient } from "../generated/console-db/client.js"

const REAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prisma", "migrations")
const M1 = "20260918202159_console_transcript"
const M2 = "20260918213501_participant_turns"

function scratch(): { root: string; client: () => PrismaClient } {
  const root = mkdtempSync(join(tmpdir(), "console-migrations-"))
  return { root, client: () => new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${join(root, "t.db")}` }) }) }
}

/** A migrations directory holding only the named real migrations, plus any extras. */
function migrationsDir(args: { root: string; names: string[]; extra: Record<string, string> }): string {
  const { root, names, extra } = args
  const dir = join(root, `migrations-${names.length}-${Object.keys(extra).length}`)
  for (const n of names) {
    mkdirSync(join(dir, n), { recursive: true })
    copyFileSync(join(REAL_DIR, n, "migration.sql"), join(dir, n, "migration.sql"))
  }
  for (const [n, sql] of Object.entries(extra)) {
    mkdirSync(join(dir, n), { recursive: true })
    writeFileSync(join(dir, n, "migration.sql"), sql)
  }
  return dir
}

const columns = async (prisma: PrismaClient) => (await prisma.$queryRawUnsafe<{ name: string }[]>('SELECT "name" FROM pragma_table_info(?)', "Message")).map((r) => r.name)
const ledger = async (prisma: PrismaClient) => (await prisma.$queryRawUnsafe<{ name: string }[]>('SELECT "name" FROM "_console_migrations" ORDER BY "name"')).map((r) => r.name)
/** Turn a migrated database into one built before the ledger existed. */
const forgetLedger = (prisma: PrismaClient) => prisma.$executeRawUnsafe('DELETE FROM "_console_migrations"')

export async function runConsoleMigrationsTest(): Promise<number> {
  let failures = 0
  type Ctx = { s: ReturnType<typeof scratch>; prisma: PrismaClient }
  // Each case gets a fresh scratch database, closed and deleted afterwards.
  const check = async (name: string, test: (ctx: Ctx) => Promise<void>) => {
    const s = scratch()
    const prisma = s.client()
    try {
      await test({ s, prisma })
      console.log(`  [PASS] ${name}`)
    } catch (error) {
      failures++
      console.error(`  [FAIL] ${name}`, error)
    } finally {
      await prisma.$disconnect()
      rmSync(s.root, { recursive: true, force: true })
    }
  }
  console.log("\n[console] transcript migrations")

  await check("a fresh database gets every migration", async ({ prisma }) => {
    const r = await applyMigrations({ prisma, dir: REAL_DIR })
    assert.deepEqual(r.applied, [M1, M2])
    assert.ok((await columns(prisma)).includes("author"))
  })

  await check("a database with only the FIRST migration gets the second", async ({ s, prisma }) => {
    // The regression. Built before the ledger, first migration only.
    await applyMigrations({ prisma, dir: migrationsDir({ root: s.root, names: [M1], extra: {} }) })
    await forgetLedger(prisma)
    assert.equal((await columns(prisma)).includes("author"), false, "precondition: author is missing")

    const r = await applyMigrations({ prisma, dir: REAL_DIR })
    assert.deepEqual(r.baselined, [M1])
    assert.deepEqual(r.applied, [M2])
    assert.ok((await columns(prisma)).includes("author"))
  })

  await check("a fully migrated pre-ledger database is recorded, not re-run, and keeps its rows", async ({ prisma }) => {
    // Every console database made so far looks like this.
    await applyMigrations({ prisma, dir: REAL_DIR })
    await prisma.$executeRawUnsafe(`INSERT INTO "Conversation" ("id", "updatedAt") VALUES ('default', CURRENT_TIMESTAMP)`)
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" ("id", "conversationId", "seq", "role", "payload", "updatedAt") VALUES ('default:0:a', 'default', 0, 'user', '{}', CURRENT_TIMESTAMP)`,
    )
    await forgetLedger(prisma)

    const r = await applyMigrations({ prisma, dir: REAL_DIR })
    assert.deepEqual(r.baselined, [M1, M2])
    assert.deepEqual(r.applied, [], "nothing may be re-run against existing tables")
    const n = await prisma.$queryRawUnsafe<{ n: number | bigint }[]>('SELECT COUNT(*) AS "n" FROM "Message"')
    assert.equal(Number(n[0].n), 1, "the existing message survives")
  })

  await check("a failing migration is not recorded, and applies once it is fixed", async ({ s, prisma }) => {
    const broken = migrationsDir({ root: s.root, names: [M1, M2], extra: { "20990101000000_later": 'ALTER TABLE "NoSuchTable" ADD COLUMN "x" TEXT;' } })
    await assert.rejects(applyMigrations({ prisma, dir: broken }), "a failed migration must surface, not be swallowed")
    assert.deepEqual(await ledger(prisma), [M1, M2], "only what fully applied is recorded")

    writeFileSync(join(broken, "20990101000000_later", "migration.sql"), 'ALTER TABLE "Message" ADD COLUMN "x" TEXT;')
    const r = await applyMigrations({ prisma, dir: broken })
    assert.deepEqual(r.applied, ["20990101000000_later"])
    assert.ok((await columns(prisma)).includes("x"))
  })

  await check("running twice applies nothing the second time", async ({ prisma }) => {
    await applyMigrations({ prisma, dir: REAL_DIR })
    const again = await applyMigrations({ prisma, dir: REAL_DIR })
    assert.deepEqual(again, { applied: [], baselined: [] })
  })

  return failures
}
