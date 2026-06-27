import { and, asc, eq } from 'drizzle-orm';
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
export async function appendEvent(
  e: AppendEventInput
): Promise<{ id: number; inserted: boolean }> {
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
    .returning({ id: events.id });

  if (row) return { id: row.id, inserted: true };

  // Conflict on dedupeKey: the event is already filed. Return its id so the
  // caller can still wire up references without re-appending.
  const existing = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.dedupeKey, e.dedupeKey as string))
    .limit(1);
  return { id: existing[0]!.id, inserted: false };
}

export async function eventExists(dedupeKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.dedupeKey, dedupeKey))
    .limit(1);
  return Boolean(row);
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

export async function countEvents(): Promise<number> {
  const rows = await db.select({ id: events.id }).from(events);
  return rows.length;
}
