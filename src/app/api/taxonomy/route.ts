import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { listTaxonomy, addTaxonomyTag } from '@/lib/db/queries/taxonomy';

// GET is intentionally public -- the taxonomy is the allowed tag vocabulary, not sensitive data.
// It's used by the admin UI (which is itself gated) but may also be used by upload scripts.
export async function GET(_req: Request) {
  const rows = await listTaxonomy();
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let tag: string, category: string, sortOrder: number | undefined;
  try {
    const body = await req.json();
    tag = typeof body.tag === 'string' ? body.tag.trim().toLowerCase() : '';
    category = typeof body.category === 'string' ? body.category.trim().toLowerCase() : 'other';
    sortOrder = typeof body.sortOrder === 'number' ? body.sortOrder : undefined;
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  if (!tag) return NextResponse.json({ error: 'tag required' }, { status: 400 });
  if (tag.length > 60) return NextResponse.json({ error: 'tag too long' }, { status: 400 });

  try {
    const row = await addTaxonomyTag(tag, category, sortOrder);
    return NextResponse.json(row, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
      return NextResponse.json({ error: 'tag already exists' }, { status: 409 });
    }
    throw err;
  }
}
