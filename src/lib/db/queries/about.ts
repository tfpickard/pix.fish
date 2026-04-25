import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { aboutFields } from '../schema';
import type { AboutField } from '../schema';

export async function listAboutFields(ownerId: string): Promise<AboutField[]> {
  return db
    .select()
    .from(aboutFields)
    .where(eq(aboutFields.ownerId, ownerId))
    .orderBy(asc(aboutFields.sortOrder), asc(aboutFields.id));
}

export async function getAboutField(ownerId: string, key: string): Promise<AboutField | null> {
  const [row] = await db
    .select()
    .from(aboutFields)
    .where(and(eq(aboutFields.ownerId, ownerId), eq(aboutFields.key, key)))
    .limit(1);
  return row ?? null;
}

export async function upsertAboutField(input: {
  ownerId: string;
  key: string;
  label: string;
  content?: string;
  sortOrder?: number;
}): Promise<AboutField> {
  const [row] = await db
    .insert(aboutFields)
    .values({
      ownerId: input.ownerId,
      key: input.key,
      label: input.label,
      content: input.content ?? '',
      sortOrder: input.sortOrder ?? 0
    })
    .onConflictDoUpdate({
      target: [aboutFields.ownerId, aboutFields.key],
      set: {
        label: input.label,
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        updatedAt: new Date()
      }
    })
    .returning();
  if (!row) throw new Error('upsertAboutField returned no row');
  return row;
}

export async function updateAboutContent(
  ownerId: string,
  key: string,
  content: string
): Promise<AboutField | null> {
  const [row] = await db
    .update(aboutFields)
    .set({ content, updatedAt: new Date() })
    .where(and(eq(aboutFields.ownerId, ownerId), eq(aboutFields.key, key)))
    .returning();
  return row ?? null;
}
