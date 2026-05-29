import { NextResponse } from 'next/server';
import { latestProjection } from '@/lib/db/queries/umap';

export const runtime = 'nodejs';
// force-dynamic prevents Next.js from trying to pre-render this route at
// build time (which fails without POSTGRES_URL in the build environment).
// The revalidate hint is left in place for the production runtime cache.
export const dynamic = 'force-dynamic';
export const revalidate = 60;

export async function GET() {
  const row = await latestProjection();
  if (!row) return NextResponse.json({ points: [], createdAt: null });
  // points is stored as jsonb; strip internal metadata for public consumers.
  return NextResponse.json({ points: row.points, createdAt: row.createdAt });
}
