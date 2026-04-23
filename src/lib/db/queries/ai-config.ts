import { eq } from 'drizzle-orm';
import { db } from '../client';
import { aiConfig } from '../schema';
import type { AiConfig } from '../schema';

export async function listAiConfig(): Promise<AiConfig[]> {
  return db.select().from(aiConfig).orderBy(aiConfig.field);
}

export async function upsertAiConfig(
  field: string,
  provider: string,
  model: string
): Promise<AiConfig> {
  const [row] = await db
    .insert(aiConfig)
    .values({ field, provider, model })
    .onConflictDoUpdate({
      target: aiConfig.field,
      set: { provider, model, updatedAt: new Date() }
    })
    .returning();
  if (!row) throw new Error('upsertAiConfig returned no row');
  return row;
}

export async function deleteAiConfig(field: string): Promise<void> {
  await db.delete(aiConfig).where(eq(aiConfig.field, field));
}
