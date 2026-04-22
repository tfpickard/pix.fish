import { eq } from 'drizzle-orm';
import { db } from '../client';
import { prompts } from '../schema';

export type PromptKey = 'caption' | 'description' | 'tags';

export async function getPromptByKey(key: PromptKey): Promise<string | null> {
  const [row] = await db.select().from(prompts).where(eq(prompts.key, key)).limit(1);
  return row?.template ?? null;
}
