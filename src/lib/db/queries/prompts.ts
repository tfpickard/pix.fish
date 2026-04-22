import { eq } from 'drizzle-orm';
import { db } from '../client';
import { prompts } from '../schema';
import type { Prompt } from '../schema';

export type PromptKey = 'caption' | 'description' | 'tags';

export async function getPromptByKey(key: PromptKey): Promise<string | null> {
  const [row] = await db.select().from(prompts).where(eq(prompts.key, key)).limit(1);
  return row?.template ?? null;
}

export async function listPrompts(): Promise<Prompt[]> {
  return db.select().from(prompts).orderBy(prompts.key);
}

export async function updatePrompt(key: PromptKey, template: string): Promise<Prompt | null> {
  const [row] = await db
    .update(prompts)
    .set({ template, updatedAt: new Date() })
    .where(eq(prompts.key, key))
    .returning();
  return row ?? null;
}
