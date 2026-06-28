import { eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { specimens, type NewSpecimen, type Specimen } from '../schema';

// PROJECTION helpers for specimens -- one materialized case file per image.
// The detail page reads the current dossier from here rather than replaying
// the event log at request time.

export async function upsertSpecimen(input: NewSpecimen): Promise<void> {
  await db
    .insert(specimens)
    .values(input)
    .onConflictDoUpdate({
      target: specimens.imageId,
      set: {
        clerkSlug: input.clerkSlug,
        districtKey: input.districtKey,
        currentDossier: input.currentDossier,
        citations: input.citations ?? [],
        intakeEventId: input.intakeEventId,
        generation: input.generation ?? 0,
        updatedAt: input.updatedAt ?? new Date()
      }
    });
}

export async function getSpecimen(imageId: number): Promise<Specimen | null> {
  const [row] = await db.select().from(specimens).where(eq(specimens.imageId, imageId)).limit(1);
  return row ?? null;
}

export async function countSpecimens(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM specimens`);
  return Number(res.rows?.[0]?.n ?? 0);
}

export type SalienceInput = {
  imageId: number;
  fragments: number;
  distinctClerks: number;
  lastTouchedMs: number;
};

// One row per specimen with the aggregates the evolution loop scores on:
// fragment count, distinct authoring clerks, and when it was last touched.
// LEFT JOIN so a specimen with (impossibly) zero fragments still appears.
// Soft-archived images (archived_at set) are excluded so the loop never spends
// generation calls on records pulled out of public circulation.
export async function listSalienceInputs(): Promise<SalienceInput[]> {
  const res = await db.execute<{
    image_id: number;
    fragments: number;
    distinct_clerks: number;
    updated_at: string;
  }>(sql`
    SELECT s.image_id,
           count(lf.id)::int AS fragments,
           count(DISTINCT lf.clerk_slug)::int AS distinct_clerks,
           s.updated_at
    FROM specimens s
    JOIN images i ON i.id = s.image_id AND i.archived_at IS NULL
    LEFT JOIN lore_fragments lf ON lf.specimen_image_id = s.image_id
    GROUP BY s.image_id, s.updated_at
  `);
  return res.rows.map((r) => ({
    imageId: Number(r.image_id),
    fragments: Number(r.fragments),
    distinctClerks: Number(r.distinct_clerks),
    lastTouchedMs: new Date(r.updated_at).getTime()
  }));
}

export async function deleteAllSpecimens(): Promise<void> {
  await db.delete(specimens);
}
