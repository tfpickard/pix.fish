import { asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { clerks, type Clerk, type NewClerk } from '../schema';

// PROJECTION helpers for the clerk roster. Rows are materialized from
// clerk.commissioned events by the reducer; the detail page reads them to sign
// a dossier with its author's name and department.

export async function upsertClerk(input: NewClerk): Promise<void> {
  await db
    .insert(clerks)
    .values(input)
    .onConflictDoUpdate({
      target: clerks.slug,
      set: {
        name: input.name,
        department: input.department,
        voice: input.voice,
        agenda: input.agenda,
        commissionedAt: input.commissionedAt ?? new Date()
      }
    });
}

export async function getClerk(slug: string): Promise<Clerk | null> {
  const [row] = await db.select().from(clerks).where(eq(clerks.slug, slug)).limit(1);
  return row ?? null;
}

export async function listClerks(): Promise<Clerk[]> {
  return db.select().from(clerks).orderBy(asc(clerks.slug));
}

// Rebuild support: clear the projection before replaying the log. DELETE (not
// TRUNCATE) so we never trip a TRUNCATE ... CASCADE into unrelated tables.
export async function deleteAllClerks(): Promise<void> {
  await db.delete(clerks);
}
