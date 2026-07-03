import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getEmailUserByEmail,
  getUserByHandle,
  createEmailUser
} from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/password';
import { rateLimit } from '@/lib/rate-limit';
import { getRequestIp, hashIp } from '@/lib/hash';

export const runtime = 'nodejs';

// Email/password sign-up. Creates an 'email' provider user with an OPAQUE id
// (`email:<uuid>`) -- never the raw address, which would leak via images.ownerId
// in the public image API. The address lives only in the `email` column and is
// kept unique by the users_email_provider_uniq partial index. The session is
// minted by a follow-up signIn('credentials', ...) from the client. Kept off the
// NextAuth catch-all path so there is no route ambiguity.

const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(8).max(200),
  name: z.string().trim().max(80).optional()
});

// Postgres surfaces a unique-constraint violation as SQLSTATE 23505.
function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

// The constraint name lets us tell an email-uniqueness violation (a duplicate
// registration -> 409) apart from a handle-uniqueness violation (a concurrent
// handle race -> retry). Returns null if the driver didn't populate it.
function pgConstraint(err: unknown): string | null {
  if (err && typeof err === 'object' && 'constraint' in err) {
    const c = (err as { constraint?: unknown }).constraint;
    return typeof c === 'string' ? c : null;
  }
  return null;
}

// Mirror the handle slugify used in auth.ts, resolving collisions here so the
// row is created with a stable public handle.
async function resolveHandle(seed: string, ownId: string): Promise<string> {
  const base =
    seed
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'user';
  let candidate = base;
  let n = 1;
  while (n < 100) {
    const existing = await getUserByHandle(candidate);
    if (!existing || existing.id === ownId) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
  return `${base}-${ownId.slice(0, 8).replace(/[^a-z0-9-]/g, '')}`;
}

export async function POST(req: Request) {
  // Public endpoint: throttle per-IP before the synchronous scrypt hash and the
  // insert, so an attacker can't force CPU-heavy hashing (or row creation) by
  // spamming unique emails. Same in-memory helper as the credentials flow.
  if (!rateLimit(`register:ip:${hashIp(getRequestIp(req))}`, 5, 10 * 60_000)) {
    return NextResponse.json({ error: 'too many attempts -- try again later' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? 'invalid input' },
      { status: 400 }
    );
  }

  const { email, password, name } = parsed.data;
  // Opaque id -- see the file header. The address is matched via the email
  // column, not the id.
  const id = `email:${randomUUID()}`;

  // Fast pre-check for a clean "already registered" response. Case-insensitive
  // and scoped to provider='email', so an OAuth user who happens to share this
  // address (different provider, different id) is deliberately not matched. The
  // users_email_provider_uniq index is the authoritative guard against a
  // concurrent duplicate that slips past this read.
  const existing = await getEmailUserByEmail(email);
  if (existing) {
    return NextResponse.json({ error: 'an account with that email already exists' }, { status: 409 });
  }

  const passwordHash = hashPassword(password);

  // Two unique constraints can trip on insert: users_email_provider_uniq (a
  // concurrent duplicate registration -> 409) and users_handle_unique (a
  // concurrent sign-up that resolved the same handle between our resolveHandle()
  // read and our insert -> retry with a fresh handle). Both surface as SQLSTATE
  // 23505; we branch on the constraint name, falling back to an email re-check
  // when the driver omits it.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await resolveHandle(email.split('@')[0] || 'user', id);
    try {
      const row = await createEmailUser({
        id,
        handle,
        displayName: name ?? null,
        email,
        avatarUrl: null,
        provider: 'email',
        role: 'user',
        passwordHash
      });
      // The opaque UUID id makes an id conflict effectively impossible; treat a
      // null row (onConflictDoNothing on id) as a retry rather than success.
      if (!row) {
        lastErr = new Error('unexpected id conflict');
        continue;
      }
      return NextResponse.json({ ok: true }, { status: 201 });
    } catch (err) {
      lastErr = err;
      if (!isUniqueViolation(err)) {
        console.error('register: createEmailUser failed', err);
        return NextResponse.json({ error: 'could not create account' }, { status: 500 });
      }
      const constraint = pgConstraint(err);
      if (constraint === 'users_email_provider_uniq' || (!constraint && (await getEmailUserByEmail(email)))) {
        return NextResponse.json(
          { error: 'an account with that email already exists' },
          { status: 409 }
        );
      }
      // Otherwise it's the handle constraint -- loop and re-resolve.
    }
  }

  console.error('register: exhausted handle-resolution retries', lastErr);
  return NextResponse.json({ error: 'could not create account' }, { status: 500 });
}
