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

  // Fast pre-check so we can return a clean "already registered" without
  // relying solely on the insert conflict (also catches OAuth rows that
  // happen to share the address via the same email:<addr> key never colliding,
  // but a prior email registration will).
  const existing = await getUserById(id);
  if (existing) {
    return NextResponse.json({ error: 'an account with that email already exists' }, { status: 409 });
  }

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
      passwordHash: hashPassword(password)
    });
    if (!row) {
      // Lost a race with a concurrent registration for the same email.
      return NextResponse.json({ error: 'an account with that email already exists' }, { status: 409 });
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error('register: createEmailUser failed', err);
    return NextResponse.json({ error: 'could not create account' }, { status: 500 });
  }
}
