import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

// Password hashing for email/password ('email' provider) users. We use Node's
// built-in scrypt rather than pulling in bcrypt/argon2 -- it needs no native
// build step (which fits the bun + Vercel Node runtime) and the auth route
// already runs `runtime = 'nodejs'`. The stored format is
// `scrypt$<salt-hex>$<hash-hex>` so the salt travels with the digest.

const KEYLEN = 64;
const SCRYPT_COST = 16384; // N; 2^14, the Node default

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEYLEN, { N: SCRYPT_COST });
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

// Constant-time verify. Returns false on any malformed/legacy value rather
// than throwing so a bad row can't 500 the sign-in path.
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const derived = scryptSync(password, salt, expected.length, { N: SCRYPT_COST });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
