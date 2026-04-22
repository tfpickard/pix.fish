import { NextResponse } from 'next/server';
import { auth, isOwner } from '@/lib/auth';
import { listApiKeys, createApiKey, generateToken } from '@/lib/db/queries/api-keys';

export async function GET(_req: Request) {
  const session = await auth();
  if (!isOwner(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const ownerId = session!.user!.githubId as string;
  const rows = await listApiKeys(ownerId);
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!isOwner(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const ownerId = session!.user!.githubId as string;

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
