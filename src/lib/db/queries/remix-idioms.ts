import { asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { remixIdioms } from '../schema';
import type { RemixIdiom } from '../schema';

// Active idioms in label order for the remix menu. Soft-fails to [] if the
// table is missing so the detail page still renders pre-migration.
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

export async function getRemixIdiom(key: string): Promise<RemixIdiom | null> {
  const [row] = await db.select().from(remixIdioms).where(eq(remixIdioms.key, key)).limit(1);
  return row ?? null;
}
