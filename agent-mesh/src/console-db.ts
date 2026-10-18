// The console's transcript store.
//
// SQLite through Prisma, in this package, on this host — see prisma/schema.prisma for
// why it is a local file. The store is deliberately tiny: it holds the
// conversation so it survives a reload, a device change, and returning from a
// notification, and nothing else.
//
// Privacy: this is what the operator and the assistant said to each other. It stays on this
// host, it is never shipped anywhere, and message bodies are never logged.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3"
import { PrismaClient } from "./generated/console-db/client.js"
import { consoleDatabaseUrl, prepareConsoleDatabaseFile } from "./console-db-url.js"
import { mergeTranscripts, messageKey } from "./transcript-merge.js"

// One conversation, unless a second surface ever needs its own. Explicit rather than
// implicit so nothing has to guess which thread it is appending to.
export const DEFAULT_CONVERSATION = "default"

// How much of a conversation a surface is SENT — the newest messages only. Generous
// enough that the whole of a working day is there when they come back to it.
//
// A cap on what is served, never on what is stored. Trimming the store looks like the
// natural bound and breaks the merge: a stale surface resends messages that have aged
// out, the store no longer knows them, so they come back as new turns and the newest
// real ones are trimmed to make room. Stored in full, every message a surface can hold
// still has its row, and a resend updates it in place. One operator's text grows by
// megabytes a year; saves write only what changed, so the size does not tax them.
const SERVED_MESSAGES = 400

let client: PrismaClient | null = null
let unavailable: string | null = null
let schema: Promise<boolean> | null = null

/**
 * Bring the database file up to date with the committed migrations, once per process.
 *
 * A fresh box, a deleted file or a scratch path all start with no tables; the store heals
 * itself rather than reporting available while every write fails. See `applyMigrations`.
 *
 * Every caller shares ONE initialisation. A flag set on success is not enough: the
 * console's first page load fires several requests at once, each would see "not yet
 * migrated" and run the same migrations, and the loser fails on the winner's tables
 * and reports the store unavailable. A failure clears the shared promise, so the next
 * request retries whatever did not complete.
 */
function ensureSchema(prisma: PrismaClient): Promise<boolean> {
  schema ??= migrate(prisma).then((ok) => {
    if (!ok) {
      schema = null
    }
    return ok
  })
  return schema
}

async function migrate(prisma: PrismaClient): Promise<boolean> {
  try {
    const result = await applyMigrations({ prisma, dir: MIGRATIONS_DIR() })
    if (result.applied.length > 0 || result.baselined.length > 0) {
      process.stdout.write(`[console] transcript schema: applied=${result.applied.join(",") || "-"} baselined=${result.baselined.join(",") || "-"}\n`)
    }
    return true
  } catch (e) {
    // Surfaced, not swallowed: a store that cannot migrate is reported unavailable.
    process.stdout.write(`[console] transcript schema migration FAILED: ${(e as Error).message.replace(/[\r\n]+/g, " ").slice(0, 300)}\n`)
    return false
  }
}

const MIGRATIONS_DIR = () => join(dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations")

/**
 * Apply every committed migration the ledger has not recorded.
 *
 * Tracked in a ledger table, not inferred from a probe. "The `Conversation` table
 * exists" does not mean "migrated": a database that got the first migration and not
 * the second passes that probe and then fails every write that touches `author`, and
 * nothing ever retries it. Each migration runs in one transaction together with its
 * ledger row, so it is either wholly applied and recorded or not recorded at all — a
 * failure is thrown to the caller rather than skipped, and the next start picks up
 * exactly where this one stopped.
 *
 * Exported for tests, which run it against scratch database files.
 */
export async function applyMigrations(args: { prisma: PrismaClient; dir: string }): Promise<{ applied: string[]; baselined: string[] }> {
  const { prisma } = args
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "_console_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  )
  const baselined = await baselinePreLedgerDatabase(prisma)
  const done = new Set((await prisma.$queryRawUnsafe<{ name: string }[]>('SELECT "name" FROM "_console_migrations"')).map((r) => r.name))
  if (!existsSync(args.dir)) {
    return { applied: [], baselined }
  }
  const pending = readdirSync(args.dir)
    .filter((d) => existsSync(join(args.dir, d, "migration.sql")) && !done.has(d))
    .sort()
  const applied: string[] = []
  for (const name of pending) {
    const statements = splitStatements(readFileSync(join(args.dir, name, "migration.sql"), "utf8"))
    await prisma.$transaction(async (tx) => {
      for (const statement of statements) {
        // Awaited, one at a time, and NOT caught: an unawaited call executes nothing,
        // and a caught one records a migration that never ran.
        await tx.$executeRawUnsafe(statement)
      }
      await tx.$executeRawUnsafe('INSERT INTO "_console_migrations" ("name") VALUES (?)', name)
    })
    applied.push(name)
  }
  return { applied, baselined }
}

// The two migrations that existed before the ledger, and how to tell each is already
// in a database built by the old self-heal. Frozen: every migration after these is
// recorded by applyMigrations as it runs, so this list never grows.
const PRE_LEDGER_MIGRATIONS: { name: string; present: (prisma: PrismaClient) => Promise<boolean> }[] = [
  { name: "20260918202159_console_transcript", present: async (prisma) => (await tableColumns(prisma, "Message")).length > 0 },
  { name: "20260918213501_participant_turns", present: async (prisma) => (await tableColumns(prisma, "Message")).includes("author") },
]

/**
 * Record, without re-running, the pre-ledger migrations a database already has.
 *
 * Only for a database with no ledger rows but existing tables — one created by the old
 * self-heal, which is every console database made so far. Re-running its migrations
 * would fail on `CREATE TABLE`, and treating it as empty would be worse.
 */
async function baselinePreLedgerDatabase(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ n: number | bigint }[]>('SELECT COUNT(*) AS "n" FROM "_console_migrations"')
  if (Number(rows[0]?.n ?? 0) > 0) {
    return []
  }
  const baselined: string[] = []
  for (const m of PRE_LEDGER_MIGRATIONS) {
    if (!(await m.present(prisma))) {
      break // later migrations depend on earlier ones; the rest are genuinely pending
    }
    await prisma.$executeRawUnsafe('INSERT INTO "_console_migrations" ("name") VALUES (?)', m.name)
    baselined.push(m.name)
  }
  return baselined
}

async function tableColumns(prisma: PrismaClient, table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>('SELECT "name" FROM pragma_table_info(?)', table)
  return rows.map((r) => r.name)
}

/**
 * Split a Prisma migration file into executable statements.
 *
 * Strips leading comment LINES, not statements that begin with one: Prisma writes
 * "-- CreateTable" directly above each CREATE, so filtering on startsWith("--") would
 * discard the whole statement.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((x) =>
      x
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((x) => x !== "")
}

function db(): PrismaClient | null {
  if (client != null) {
    return client
  }
  if (unavailable != null) {
    return null
  }
  try {
    const url = consoleDatabaseUrl()
    prepareConsoleDatabaseFile(url)
    client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) })
    return client
  } catch (e) {
    // A console that cannot open its database must still WORK — the browser keeps its
    // own copy. Persistence is an upgrade, not a dependency, so a missing migration or
    // an unwritable home directory degrades to the old behaviour instead of a dead app.
    unavailable = (e as Error).message
    return null
  }
}

/**
 * Honest availability: a constructed client is not a usable store. Probing with a real
 * query is what distinguishes "ready" from "no schema", which otherwise reports
 * available and silently discards every write.
 */
export async function transcriptAvailable(): Promise<boolean> {
  const prisma = db()
  if (prisma == null) {
    return false
  }
  return ensureSchema(prisma)
}

export type StoredMessage = {
  id: string
  role: string
  payload: unknown
  /** Agent id for a participant turn; null for the operator and the console assistant. */
  author?: string | null
  /** The request this turn answers. */
  correlationId?: string | null
}
export type ConversationSummary = { id: string; title: string; messages: number; updatedAt: string }

/** Every conversation, newest activity first, for the switcher. */
export async function listConversations(): Promise<ConversationSummary[]> {
  const prisma = db()
  if (prisma == null || !(await ensureSchema(prisma))) {
    return []
  }
  try {
    const rows = await prisma.conversation.findMany({
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true, messages: { select: { role: true, payload: true }, orderBy: { seq: "asc" }, take: 6 }, _count: { select: { messages: true } } },
    })
    return rows.map((c) => ({
      id: c.id,
      // Titled from the first thing THE OPERATOR said. An assistant opener is boilerplate and
      // would make every chat look identical in the list.
      title: firstUserText(c.messages) ?? "New chat",
      messages: c._count.messages,
      updatedAt: c.updatedAt.toISOString(),
    }))
  } catch {
    return []
  }
}

function firstUserText(messages: Array<{ role: string; payload: string }>): string | null {
  for (const m of messages) {
    if (m.role !== "user") {
      continue
    }
    try {
      const parsed = JSON.parse(m.payload) as { parts?: Array<{ type?: string; text?: string }> }
      const text = (parsed.parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join(" ")
        .trim()
      if (text !== "") {
        return text.length > 60 ? `${text.slice(0, 59)}…` : text
      }
    } catch {
      // unreadable payload — fall through to the next message
    }
  }
  return null
}

/**
 * Which conversation asked the question this correlation id answers.
 *
 * Derived from the stored transcripts rather than a side table: the ask is already
 * recorded there as a completed send_message tool result carrying the id, and a second
 * source of truth could only drift out of step with the conversation it describes.
 */
export async function conversationForCorrelation(correlationId: string): Promise<string | null> {
  const prisma = db()
  if (prisma == null || correlationId === "" || !(await ensureSchema(prisma))) {
    return null
  }
  try {
    const row = await prisma.message.findFirst({
      where: { OR: [{ correlationId }, { payload: { contains: correlationId } }] },
      orderBy: { createdAt: "desc" },
      select: { conversationId: true },
    })
    return row?.conversationId ?? null
  } catch {
    return null
  }
}

/**
 * Has this console ever been used from anywhere?
 *
 * The digest needs to tell "they have been away" apart from "this has never been opened":
 * a week of mail presented to a first-time visitor as things they missed is the
 * opposite of the point. Existence of the conversation row is the durable answer, and
 * unlike a timestamp it cannot be moved by a surface merely opening.
 */
export async function conversationLastSave(conversationId = DEFAULT_CONVERSATION): Promise<string | null> {
  const prisma = db()
  if (prisma == null || !(await ensureSchema(prisma))) {
    return null
  }
  try {
    // Every save rewrites the rows, so this is when the transcript was last WRITTEN by
    // any surface — not when anything was said. A weak signal, and used as one: it only
    // stands in when nothing better exists, because a surface bumps it merely by
    // opening the console.
    const row = await prisma.message.findFirst({ where: { conversationId }, orderBy: { seq: "desc" }, select: { updatedAt: true } })
    return row?.updatedAt.toISOString() ?? null
  } catch {
    return null
  }
}

export async function conversationEverUsed(conversationId = DEFAULT_CONVERSATION): Promise<boolean> {
  const prisma = db()
  if (prisma == null || !(await ensureSchema(prisma))) {
    return false
  }
  try {
    return (await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true } })) != null
  } catch {
    return false
  }
}

export async function loadTranscript(conversationId = DEFAULT_CONVERSATION): Promise<StoredMessage[]> {
  const prisma = db()
  if (prisma == null || !(await ensureSchema(prisma))) {
    return []
  }
  try {
    const newest = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { seq: "desc" },
      take: SERVED_MESSAGES,
      select: { id: true, role: true, payload: true, author: true, correlationId: true },
    })
    const rows = newest.reverse()
    return rows.map((r) => ({ id: r.id, role: r.role, payload: JSON.parse(r.payload) as unknown, author: r.author, correlationId: r.correlationId }))
  } catch {
    return []
  }
}

export type SaveOutcome = { saved: boolean; stored: number; behind: number; reason?: "unavailable" | "error" }

/**
 * Save a surface's copy of a conversation by MERGING it into the stored one.
 *
 * Not a replace. A replace made whatever the client held the entire durable contents,
 * so two devices that each appended a message both sent the same count and the second
 * save deleted the first device's message — see transcript-merge.ts. Merged, every
 * message the store holds survives every save, and a surface that is behind (a fresh
 * tab, a second device, the iOS Home Screen app's separate storage) can no longer
 * truncate the history. There is no length floor: a count cannot tell two diverged
 * copies apart, and nothing it would guard against can happen.
 *
 * `behind` in the result is how many stored messages the surface did not send; the
 * client re-reads the conversation when it is non-zero.
 *
 * Saves to one conversation are serialised. The merge reads, then writes, so two saves
 * interleaving could each merge from a snapshot missing the other's message — the loss
 * the merge exists to prevent, one layer down.
 */
export async function saveTranscript(args: { conversationId?: string; messages: StoredMessage[] }): Promise<SaveOutcome> {
  const prisma = db()
  if (prisma == null || !(await ensureSchema(prisma))) {
    return { saved: false, stored: 0, behind: 0, reason: "unavailable" }
  }
  const conversationId = args.conversationId ?? DEFAULT_CONVERSATION
  const previous = savesInFlight.get(conversationId) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(() => writeMerged({ prisma, conversationId, incoming: args.messages }))
  savesInFlight.set(conversationId, run)
  try {
    return await run
  } finally {
    if (savesInFlight.get(conversationId) === run) {
      savesInFlight.delete(conversationId)
    }
  }
}

const savesInFlight = new Map<string, Promise<SaveOutcome>>()

async function writeMerged(args: { prisma: PrismaClient; conversationId: string; incoming: StoredMessage[] }): Promise<SaveOutcome> {
  const { prisma, conversationId } = args
  try {
    const storedRows = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { seq: "asc" },
      select: { id: true, role: true, payload: true, author: true, correlationId: true },
    })
    // Keyed by the MESSAGE id inside the payload. The row id is `conversation:seq:id`,
    // which changes whenever seq does and would match nothing — duplicating the whole
    // conversation on every save.
    const stored = storedRows.map((r) => {
      const payload = JSON.parse(r.payload) as { id?: unknown }
      return { id: typeof payload.id === "string" ? payload.id : "", role: r.role, payload, author: r.author, correlationId: r.correlationId, rowId: r.id, raw: r.payload }
    })
    const merged = mergeTranscripts<StoredMessage & { rowId?: string; raw?: string }>({ stored, incoming: args.incoming })
    const data = (m: StoredMessage, seq: number) => ({
      id: `${conversationId}:${seq}:${m.id}`,
      conversationId,
      seq,
      role: m.role,
      // Denormalised out of the payload so a reply can be found by the request it
      // answers without scanning every transcript as JSON.
      author: m.author ?? null,
      correlationId: m.correlationId ?? null,
      payload: JSON.stringify(m.payload),
    })
    // Every stored row still at its position: the save only updated messages in place
    // and appended. That is every save but a surface bringing back history older than
    // the store's, so it writes just the changed and new rows. Otherwise positions
    // moved and the conversation is rewritten.
    const inPlace = stored.every((r, i) => messageKey(merged.rows[i]) === messageKey(r))
    const writes = inPlace
      ? [
          ...stored.flatMap((r, i) => {
            const next = merged.rows[i]
            const row = data(next, i)
            return row.payload === r.raw && row.author === r.author && row.correlationId === r.correlationId
              ? []
              : [prisma.message.update({ where: { id: r.rowId }, data: { payload: row.payload, role: row.role, author: row.author, correlationId: row.correlationId } })]
          }),
          ...merged.rows.slice(stored.length).map((m, i) => prisma.message.create({ data: data(m, stored.length + i) })),
        ]
      : [prisma.message.deleteMany({ where: { conversationId } }), ...merged.rows.map((m, seq) => prisma.message.create({ data: data(m, seq) }))]
    await prisma.$transaction([
      // `updatedAt` is set EXPLICITLY. `@updatedAt` only fires for fields the update
      // actually writes, and this update writes none — so an empty `update: {}` left
      // the column frozen at the row's creation time. Two things read it as "last
      // activity": the chat switcher, which sorts and timestamps by it, and the
      // digest's fallback window on a device with no local mark.
      prisma.conversation.upsert({ where: { id: conversationId }, create: { id: conversationId }, update: { updatedAt: new Date() } }),
      ...writes,
    ])
    return { saved: true, stored: merged.rows.length, behind: merged.behind }
  } catch {
    return { saved: false, stored: 0, behind: 0, reason: "error" }
  }
}
