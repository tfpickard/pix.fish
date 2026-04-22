import { NextResponse } from 'next/server';
import { auth, isOwner } from '@/lib/auth';
import { listPrompts } from '@/lib/db/queries/prompts';

export async function GET(_req: Request) {
  const session = await auth();
  if (!isOwner(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const rows = await listPrompts();
  return NextResponse.json(rows);
}
