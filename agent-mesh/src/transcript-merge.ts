// Combining a stored transcript with one a client is saving.
//
// A save is a MERGE by message id, never a replace. Replacing made whatever the client
// held the entire durable contents, which is only safe when exactly one surface writes:
// two devices that each loaded the same 10 messages and appended one each both sent
// 11, and the second replace silently deleted the first device's message. A count
// cannot tell those two transcripts apart, so no floor on length could have caught it.
//
// Merging makes that class of loss impossible rather than guarded: every message the
// store already holds survives any save, whatever the client sent.
//
// Messages are matched by id. An id that is empty falls back to the message's content —
// rare, and good enough to stop an unkeyed message
// duplicating on every save.

/** What a transcript row carries for the purpose of merging. */
type Row = { id: string; payload: unknown }

/** The identity two copies of one message share. */
export function messageKey(row: Row): string {
  return row.id !== "" ? `id:${row.id}` : `content:${JSON.stringify(row.payload)}`
}

/**
 * The stored rows in their stored order, each replaced by the client's version when it
 * sent one, plus the client's rows the store did not have.
 *
 * An in-place update wins because the AI SDK streams into a message under a fixed id:
 * the latest save of it is the most complete. Stored order wins because the client only
 * ever appends; a client never reorders a conversation.
 *
 * A row the store lacks is placed by its ANCHOR — the nearest row before it, in the
 * client's order, that the store does have. Unanchored rows that come before the
 * client's first anchor are OLDER than everything the two share, so they go in front;
 * that is the client holding history from before the window the server sent it. Every
 * other new row goes at the end. Appending them all at the end instead files old
 * history as the newest turns. A client with no anchor at all — a one-entry save of an
 * arrival — is appending, so its rows go at the end.
 *
 * `behind` counts rows in the result the client did not send that come after the
 * first row it did: messages it is missing from inside or after its own window, which
 * is the signal to re-read. History older than its window is not "behind" — a surface
 * holding the last 60 messages of a 2,000-message conversation is current.
 */
export function mergeTranscripts<R extends Row>(args: { stored: R[]; incoming: R[] }): { rows: R[]; behind: number } {
  const storedKeys = new Set(args.stored.map(messageKey))
  const incomingByKey = new Map(args.incoming.map((r) => [messageKey(r), r]))
  const firstAnchor = args.incoming.findIndex((r) => storedKeys.has(messageKey(r)))

  const seen = new Set<string>()
  const take = (rs: R[]): R[] =>
    rs.filter((r) => {
      const k = messageKey(r)
      if (storedKeys.has(k) || seen.has(k)) {
        return false
      }
      seen.add(k)
      return true
    })
  const older = firstAnchor > 0 ? take(args.incoming.slice(0, firstAnchor)) : []
  const kept = args.stored.map((r) => incomingByKey.get(messageKey(r)) ?? r)
  const newer = take(firstAnchor >= 0 ? args.incoming.slice(firstAnchor) : args.incoming)
  const rows = [...older, ...kept, ...newer]

  const sent = new Set(incomingByKey.keys())
  const firstSent = rows.findIndex((r) => sent.has(messageKey(r)))
  const behind = firstSent < 0 ? 0 : rows.slice(firstSent).filter((r) => !sent.has(messageKey(r))).length
  return { rows, behind }
}
