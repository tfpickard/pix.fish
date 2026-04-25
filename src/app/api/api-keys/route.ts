import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { listApiKeys, createApiKey, generateToken } from '@/lib/db/queries/api-keys';

// Multi-user: every signed-in user manages their own PATs. The route is
// per-user shaped end-to-end -- no admin override -- so a site admin
// cannot accidentally see another user's tokens.
export async function GET(_req: Request) {
  const session = await auth();
  const ownerId = session?.user?.id ?? session?.user?.githubId;
  if (!ownerId) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const rows = await listApiKeys(ownerId);
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const session = await auth();
  const ownerId = session?.user?.id ?? session?.user?.githubId;
  if (!ownerId) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let label: string;
  try {
    const body = await req.json();
    label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  if (!label) return NextResponse.json({ error: 'label required' }, { status: 400 });

  const { raw, hash } = generateToken();
  await createApiKey(ownerId, label, hash);

  // Return the raw token exactly once -- it is never retrievable again
  return NextResponse.json({ token: raw, label }, { status: 201 });
}
