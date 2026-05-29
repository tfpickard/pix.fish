import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { remixIdioms } from '../schema';
import type { RemixIdiom } from '../schema';

// How many idioms to surface per page load. Small enough that the pool stays
// fresh across visits; large enough to fill the chip row without clipping.
export const REMIX_IDIOMS_PER_LOAD = 12;

// Active idioms in label order -- the full set. Kept for contexts that need
// the whole pool (e.g. admin listings). For the public remix menu use the
// sampled variant below so each load feels different.
export async function listRemixIdioms(): Promise<RemixIdiom[]> {
  try {
    return await db
      .select()
      .from(remixIdioms)
      .where(eq(remixIdioms.active, true))
      .orderBy(asc(remixIdioms.label));
  } catch {
    return [];
  }
}

// Random sample of active idioms, n per load. ORDER BY random() is fine here
// because the table is small (O(hundreds)); no index scan overhead worth
// worrying about. Soft-fails to [] so the detail page still renders.
export async function listRemixIdiomsSampled(n: number = REMIX_IDIOMS_PER_LOAD): Promise<RemixIdiom[]> {
  try {
    return await db
      .select()
      .from(remixIdioms)
      .where(eq(remixIdioms.active, true))
      .orderBy(sql`random()`)
      .limit(n);
  } catch {
    return [];
  }
}

export async function getRemixIdiom(key: string): Promise<RemixIdiom | null> {
  const [row] = await db.select().from(remixIdioms).where(eq(remixIdioms.key, key)).limit(1);
  return row ?? null;
}
