import { desc, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { events, type UniverseEvent } from '../schema';
import { DISPATCH_EVENT_TYPES, EVENT_TYPE } from '@/lib/universe/events';
import type { SpecimenCandidate } from '@/lib/dispatch/types';

// Data layer for the outbound X dispatch. Query construction stays here, out of
// the job handler, per the project rule against inline Drizzle in handlers.

// Candidates inside a cosine-distance band from the trend vector. The band is the
// whole selection idea: nearer than the floor and the specimen is genuinely about
// the trend, which kills the joke; past the ceiling there is no thread at all.
//
// The whole corpus is eligible (recency is a weighting preference applied by the
// caller, not a filter) and NSFW rows are included by explicit product decision.
//
// Two exclusions are NOT preferences and must stay:
//   archived_at -- archived rows keep their embeddings, so without the gate a
//     deleted image could be posted to a public account.
//   basement    -- basement is an access GATE, not a visibility preference. The
//     schema calls these rows server-gated and every public reader excludes them
//     (random.ts, path-hydrate.ts, attention.ts, path-traffic.ts, stats.ts).
//     Posting one to X would publish a blob the site itself refuses to serve
//     without an unlock, which is a worse leak than any NSFW question -- the
//     NSFW inclusion here was a deliberate product call, this would not be.
//
// `intake_record` prefers the clerk's dossier, falls back to the canonical
// caption (slug-source first, else lowest variant), and finally the slug.
export async function listDispatchCandidates(params: {
  vec: number[];
  minDistance: number;
  maxDistance: number;
  limit: number;
  excludeImageIds: number[];
}): Promise<SpecimenCandidate[]> {
  const vecLiteral = `[${params.vec.join(',')}]`;
  const exclude =
    params.excludeImageIds.length > 0
      ? sql`AND i.id NOT IN (${sql.join(
          params.excludeImageIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      : sql``;

  const res = await db.execute<{
    id: number;
    slug: string;
    handle: string;
    blob_url: string;
    mime: string | null;
    is_nsfw: boolean;
    uploaded_at: string;
    distance: number;
    intake_record: string;
  }>(sql`
    SELECT
      i.id,
      i.slug,
      u.handle,
      i.blob_url,
      i.mime,
      i.is_nsfw,
      i.uploaded_at,
      e.vec <=> ${vecLiteral}::vector AS distance,
      COALESCE(NULLIF(s.current_dossier, ''), NULLIF(c.text, ''), i.slug) AS intake_record
    FROM embeddings e
    JOIN images i ON i.id = e.image_id
    JOIN users u ON u.id = i.owner_id
    LEFT JOIN specimens s ON s.image_id = i.id
    LEFT JOIN LATERAL (
      SELECT text FROM captions
      WHERE image_id = i.id
      ORDER BY is_slug_source DESC, variant ASC
      LIMIT 1
    ) c ON true
    WHERE e.kind = 'caption'
      AND e.subject_type = 'image'
      AND i.archived_at IS NULL
      AND i.basement = false
      AND (e.vec <=> ${vecLiteral}::vector) BETWEEN ${params.minDistance} AND ${params.maxDistance}
      ${exclude}
    ORDER BY distance ASC
    LIMIT ${Math.min(Math.max(Math.trunc(params.limit), 1), 2000)}
  `);

  return res.rows.map((r) => ({
    imageId: Number(r.id),
    slug: r.slug,
    handle: r.handle,
    blobUrl: r.blob_url,
    mime: r.mime,
    isNsfw: Boolean(r.is_nsfw),
    uploadedAt: new Date(r.uploaded_at),
    intakeRecord: r.intake_record,
    distance: Number(r.distance)
  }));
}

// Image ids that have already been dispatched (in either mode). Read straight
// off the append-only log rather than a projection: the log is the record, and a
// specimen should not be sent twice even after a projection rebuild.
export async function listDispatchedImageIds(): Promise<number[]> {
  const res = await db.execute<{ image_id: number }>(sql`
    SELECT DISTINCT (payload->>'imageId')::int AS image_id
    FROM events
    WHERE type = ${EVENT_TYPE.DispatchSent}
      AND payload->>'imageId' IS NOT NULL
  `);
  return res.rows.map((r) => Number(r.image_id)).filter((n) => Number.isFinite(n));
}

// Recent dispatch activity (sent and skipped) for /admin/dispatch, newest first.
export async function listRecentDispatchEvents(limit = 40): Promise<UniverseEvent[]> {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 200);
  return db
    .select()
    .from(events)
    .where(inArray(events.type, [...DISPATCH_EVENT_TYPES]))
    .orderBy(desc(events.id))
    .limit(lim);
}

// Whether a given UTC date already has a dispatch outcome on file. Used by the
// admin page to show today's state; the hard once-per-day guarantee is enforced
// by the claim event's unique dedupe key, not by this read.
export async function dispatchOutcomeForDate(dateKey: string): Promise<UniverseEvent | null> {
  const [row] = await db
    .select()
    .from(events)
    .where(
      sql`${events.subjectType} = 'dispatch' AND ${events.subjectId} = ${dateKey} AND ${events.type} <> ${EVENT_TYPE.DispatchClaimed}`
    )
    .orderBy(desc(events.id))
    .limit(1);
  return row ?? null;
}

export async function countDispatchEventsOfType(type: string): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM events WHERE type = ${type}`
  );
  return Number(res.rows?.[0]?.n ?? 0);
}
