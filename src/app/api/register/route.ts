import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserById, getUserByHandle, createEmailUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/password';

export const runtime = 'nodejs';

// Email/password sign-up. Creates an 'email' provider user keyed on
// `email:<lowercased-email>`; the actual session is minted by a follow-up
// signIn('credentials', ...) from the client. Kept off the NextAuth catch-all
// path so there is no route ambiguity.

const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(8).max(200),
  name: z.string().trim().max(80).optional()
});

// Postgres surfaces a unique-constraint violation as SQLSTATE 23505. Used to
// distinguish a `users.handle` race (retryable) from a real failure.
function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
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
  const id = `email:${email}`;

  // Fast pre-check for a clean "already registered" response. This only matches
  // a prior email/password row: OAuth identities are keyed google:<sub> /
  // apple:<sub> / <github-numeric-id>, so an OAuth user who happens to share
  // this address has a different id and is deliberately not matched here. The
  // insert's onConflictDoNothing on the id is the authoritative duplicate guard.
  const existing = await getUserById(id);
  if (existing) {
    return NextResponse.json({ error: 'an account with that email already exists' }, { status: 409 });
  }

  const passwordHash = hashPassword(password);

  // The `users.handle` unique constraint can still be violated by a concurrent
  // sign-up that resolves the same handle between our resolveHandle() read and
  // our insert. That surfaces as a Postgres unique_violation (23505) -- not an
  // id conflict (those return null via onConflictDoNothing) -- so re-resolve
  // the handle and retry a bounded number of times rather than 500-ing.
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
      if (!row) {
        // Lost a race with a concurrent registration for the same email.
        return NextResponse.json(
          { error: 'an account with that email already exists' },
          { status: 409 }
        );
      }
      return NextResponse.json({ ok: true }, { status: 201 });
    } catch (err) {
      lastErr = err;
      if (isUniqueViolation(err)) continue; // handle race -- retry with a fresh handle
      console.error('register: createEmailUser failed', err);
      return NextResponse.json({ error: 'could not create account' }, { status: 500 });
    }
  }

  console.error('register: exhausted handle-resolution retries', lastErr);
  return NextResponse.json({ error: 'could not create account' }, { status: 500 });
}
