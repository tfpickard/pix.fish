import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { events, type UniverseEvent } from '../schema';

// The append-only canon. Rows are only ever inserted -- never updated, never
// deleted. Everything else in the universe is a projection rebuilt from this
// log. See src/lib/universe/reduce.ts for the reducers and
// scripts/universe-rebuild.ts for the rebuild command.

export type AppendEventInput = {
  type: string;
  subjectType: string;
  subjectId: string;
  authorClerk?: string | null;
  payload: Record<string, unknown>;
  citations?: unknown[];
  dedupeKey?: string | null;
};

// Append an event. Idempotent when a dedupeKey is supplied: a second append
// with the same key is a no-op (the unique index absorbs it) and reports
// inserted=false, so the bootstrap can run repeatedly without double-filing.
// Returns the full row (newly inserted or the pre-existing one) so callers can
// materialize it immediately without a second lookup.
export async function appendEvent(
  e: AppendEventInput
): Promise<{ event: UniverseEvent; inserted: boolean }> {
  const [row] = await db
    .insert(events)
    .values({
      type: e.type,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      authorClerk: e.authorClerk ?? null,
      payload: e.payload,
      citations: e.citations ?? [],
      dedupeKey: e.dedupeKey ?? null
    })
    .onConflictDoNothing({ target: events.dedupeKey })
    .returning();

  if (row) return { event: row, inserted: true };

  // Conflict on dedupeKey: the event is already filed. Return it so the caller
  // can still wire up references without re-appending.
  const [existing] = await db
    .select()
    .from(events)
    .where(eq(events.dedupeKey, e.dedupeKey as string))
    .limit(1);
  return { event: existing!, inserted: false };
}

export async function eventExists(dedupeKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.dedupeKey, dedupeKey))
    .limit(1);
  return Boolean(row);
}

export async function getEvent(id: number): Promise<UniverseEvent | null> {
  const [row] = await db.select().from(events).where(eq(events.id, id)).limit(1);
  return row ?? null;
}

// Highest event id of a given type in the log. Used by the character.census
// reducer to ignore a stale census whose newer successor is already on file --
// the authoritative "newest wins" check reads the append-only log, so it holds
// even when the newest census left an empty roster (no projection rows to read).
export async function latestEventIdOfType(type: string): Promise<number | null> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.type, type))
    .orderBy(desc(events.id))
    .limit(1);
  return row ? Number(row.id) : null;
}

// Largest character.census run stamp already on the log (the census subjectId is
// its run stamp). The census finalizer uses this to refuse publishing a stale run
// after a newer clustering pass has already filed -- the reducer is newest-EVENT-
// id wins, so an older run appending late would otherwise clobber newer results.
export async function maxCensusRunStamp(): Promise<number | null> {
  const res = await db.execute<{ m: string | null }>(sql`
    SELECT max((subject_id)::bigint) AS m FROM events WHERE type = 'character.census'
  `);
  const m = res.rows?.[0]?.m;
  return m == null ? null : Number(m);
}

// All events in canonical (insert) order. The rebuild replays this slice
// through the reducers; ordering by id makes the replay deterministic.
export async function listAllEvents(): Promise<UniverseEvent[]> {
  return db.select().from(events).orderBy(asc(events.id));
}

// Every event filed against a given specimen (subject_type='specimen',
// subject_id = its image id), oldest first. Powers the detail page's
// amendment-history view -- in Phase 1 that is the single intake, but the
// query is already shaped for the Phase 2 amendment stream.
export async function listSpecimenEvents(imageId: number): Promise<UniverseEvent[]> {
  return db
    .select()
    .from(events)
    .where(and(eq(events.subjectType, 'specimen'), eq(events.subjectId, String(imageId))))
    .orderBy(asc(events.id));
}

// Most recent events, newest first. Powers the chronicle/incident feed. An
// optional type allow-list keeps the feed to the canon-visible events
// (intakes, amendments, audits, district intakes) and out of bookkeeping.
export async function listRecentEvents(
  limit = 50,
  opts: { types?: string[] } = {}
): Promise<UniverseEvent[]> {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const where = opts.types && opts.types.length > 0 ? inArray(events.type, opts.types) : undefined;
  const q = db.select().from(events);
  return (where ? q.where(where) : q).orderBy(desc(events.id)).limit(lim);
}

export async function countEvents(): Promise<number> {
  const rows = await db.select({ id: events.id }).from(events);
  return rows.length;
}
