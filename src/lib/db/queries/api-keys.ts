import { createHash, randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
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

export async function revokeApiKey(id: number, ownerId: string): Promise<void> {
  await db.delete(apiKeys).where(eq(apiKeys.id, id));
  void ownerId; // auth check done in route handler; ownerId kept for future audit log
}
