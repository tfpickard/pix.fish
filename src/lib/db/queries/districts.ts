import { asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { districts, type District, type NewDistrict } from '../schema';

// PROJECTION helpers for districts -- the regions derived from the
// caption-embedding geometry. Materialized from district.intake events.

export async function upsertDistrict(input: NewDistrict): Promise<void> {
  await db
    .insert(districts)
    .values(input)
    .onConflictDoUpdate({
      target: districts.key,
      set: {
        name: input.name,
        character: input.character,
        size: input.size ?? 0,
        memberImageIds: input.memberImageIds ?? [],
        createdAt: input.createdAt ?? new Date()
      }
    });
}

export async function getDistrict(key: string): Promise<District | null> {
  const [row] = await db.select().from(districts).where(eq(districts.key, key)).limit(1);
  return row ?? null;
}

export async function listDistricts(): Promise<District[]> {
  return db.select().from(districts).orderBy(asc(districts.key));
}

export async function deleteAllDistricts(): Promise<void> {
  await db.delete(districts);
}
