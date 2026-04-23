import { desc, eq } from 'drizzle-orm';
import { db } from '../client';
import { savedPrompts } from '../schema';
import type { SavedPrompt } from '../schema';

export async function listSavedPrompts(): Promise<SavedPrompt[]> {
  return db.select().from(savedPrompts).orderBy(desc(savedPrompts.updatedAt));
}

export async function getSavedPrompt(id: number): Promise<SavedPrompt | null> {
  const [row] = await db.select().from(savedPrompts).where(eq(savedPrompts.id, id)).limit(1);
  return row ?? null;
}

export async function createSavedPrompt(input: {
  name: string;
  key: string;
  template: string;
  fragments?: unknown;
}): Promise<SavedPrompt> {
  const [row] = await db
    .insert(savedPrompts)
    .values({
      name: input.name,
      key: input.key,
      template: input.template,
      fragments: (input.fragments ?? null) as SavedPrompt['fragments']
    })
    .returning();
  if (!row) throw new Error('createSavedPrompt returned no row');
  return row;
}

export async function updateSavedPrompt(
  id: number,
  patch: Partial<{ name: string; template: string; fragments: unknown }>
): Promise<SavedPrompt | null> {
  const toSet: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) toSet.name = patch.name;
  if (patch.template !== undefined) toSet.template = patch.template;
  if (patch.fragments !== undefined) toSet.fragments = patch.fragments;
  const [row] = await db
    .update(savedPrompts)
    .set(toSet)
    .where(eq(savedPrompts.id, id))
    .returning();
  return row ?? null;
}

export async function deleteSavedPrompt(id: number): Promise<void> {
  await db.delete(savedPrompts).where(eq(savedPrompts.id, id));
}
