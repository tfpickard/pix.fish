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

export async function deleteAllSpecimens(): Promise<void> {
  await db.delete(specimens);
}
