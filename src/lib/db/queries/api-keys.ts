import { createHash, randomBytes } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { apiKeys } from '../schema';
import type { ApiKey } from '../schema';

// PAT format: pf_<48 hex chars> (24 random bytes).
// Only the SHA-256 hash is stored. The raw token is returned once on creation.
export function generateToken(): { raw: string; hash: string } {
  const raw = 'pf_' + randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export async function listApiKeys(ownerId: string): Promise<Omit<ApiKey, 'keyHash'>[]> {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.ownerId, ownerId));
  return rows.map(({ keyHash: _kh, ...rest }) => rest);
}

export async function createApiKey(
  ownerId: string,
  label: string,
  keyHash: string
): Promise<ApiKey> {
  const [row] = await db.insert(apiKeys).values({ ownerId, label, keyHash }).returning();
  return row;
}

// Defense in depth: require both id AND ownerId to match even though the route handler
// already gates on isOwner -- prevents accidental cross-owner deletion if gating ever lapses.
export async function revokeApiKey(id: number, ownerId: string): Promise<boolean> {
  const result = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.ownerId, ownerId)))
    .returning({ id: apiKeys.id });
  return result.length > 0;
}
