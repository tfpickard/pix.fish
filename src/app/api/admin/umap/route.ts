import { NextResponse } from 'next/server';
import { inArray } from 'drizzle-orm';
import { auth, isOwner } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { images } from '@/lib/db/schema';
import { latestProjection } from '@/lib/db/queries/umap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isOwner(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const row = await latestProjection();
  if (!row) return NextResponse.json({ projection: null, metas: [] });
  type Pt = { imageId: number; x: number; y: number };
  const pts = (row.points as Pt[] | null) ?? [];
  const ids = pts.map((p) => p.imageId);
  const metas =
    ids.length > 0
      ? await db.select({ id: images.id, slug: images.slug }).from(images).where(inArray(images.id, ids))
      : [];
  return NextResponse.json({ projection: row, metas });
}
