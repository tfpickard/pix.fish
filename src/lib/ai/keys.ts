import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { providerKeys, type ProviderKey } from '../db/schema';

// AES-256-GCM with a key derived from AUTH_SECRET via PBKDF2(SHA-256). The
// stored format is base64(IV || authTag || ciphertext) so a single column
// holds everything needed to decrypt. Rotating AUTH_SECRET invalidates all
// rows -- there is no key versioning, intentionally; if/when that's needed
// a `kdf_version` column will land here, not in the cipher blob.
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KDF_ITERATIONS = 100_000;
// Salt is fixed app-wide, not per-row. We're not protecting against an
// offline attacker who already has DB access AND AUTH_SECRET -- they can
// decrypt anything regardless. The salt just keeps PBKDF2 honest.
const SALT = 'pix.fish.providerKeys.v1';

// PBKDF2 at 100k iterations is intentionally slow -- so we cache the
// derived 32-byte key once per process. Keyed on AUTH_SECRET so a runtime
// rotation (rare; new pod) re-derives without restarting.
let cachedKey: { secret: string; key: Buffer } | null = null;
function deriveKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is required to encrypt or decrypt provider keys');
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;
  const key = pbkdf2Sync(secret, SALT, KDF_ITERATIONS, 32, 'sha256');
  cachedKey = { secret, key };
  return key;
}

export function encryptProviderKey(plain: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptProviderKey(blob: string): string {
  const key = deriveKey();
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('encrypted blob is too short to be valid');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export type ProviderName = 'anthropic' | 'openai';
export type UserProviderKeys = Record<ProviderName, string | null>;

// Resolve the active outbound key for each supported provider for a given
// user. Falls back to ANTHROPIC_API_KEY / OPENAI_API_KEY env vars when the
// user has no row -- this preserves the single-owner deployment model
// during the multi-user transition. New users without env access must
// configure their own keys via /admin/keys.
export async function loadUserProviderKeys(userId: string): Promise<UserProviderKeys> {
  let anthropic: string | null = null;
  let openai: string | null = null;

  let rows: ProviderKey[] = [];
  try {
    rows = await db.select().from(providerKeys).where(eq(providerKeys.ownerId, userId));
  } catch (err) {
    // Pre-migration environments don't have provider_keys yet; soft-fail
    // to env-var defaults so /api/images and the homepage keep working.
    console.error('loadUserProviderKeys: db read failed', err);
  }

  for (const r of rows) {
    let plain: string;
    try {
      plain = decryptProviderKey(r.keyEncrypted);
    } catch (err) {
      console.error('provider_keys decrypt failed for id', r.id, err);
      continue;
    }
    if (r.provider === 'anthropic') anthropic = plain;
    else if (r.provider === 'openai') openai = plain;
  }

  return {
    anthropic: anthropic ?? process.env.ANTHROPIC_API_KEY ?? null,
    openai: openai ?? process.env.OPENAI_API_KEY ?? null
  };
}
