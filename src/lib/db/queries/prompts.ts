import { eq } from 'drizzle-orm';
import { db } from '../client';
import { prompts } from '../schema';
import type { Prompt } from '../schema';

// Single source of truth for valid prompt keys. Admin endpoints that
// validate a key parameter (src/app/api/prompts/[key]/route.ts,
// src/app/api/admin/saved-prompts/[id]/promote/route.ts) read from this
// set so adding a new prompt template here automatically extends those
// allowlists too. Previously the allowlists were hardcoded, which left
// breed/depart/antibreed/subtract un-manageable through the admin UI.
export const PROMPT_KEYS = [
  'caption',
  'description',
  'tags',
  'breed',
  'depart',
  'antibreed',
  'subtract'
] as const;

export type PromptKey = (typeof PROMPT_KEYS)[number];

export const PROMPT_KEY_SET: ReadonlySet<PromptKey> = new Set(PROMPT_KEYS);

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
