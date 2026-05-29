import { NextResponse } from 'next/server';
import { latestProjection } from '@/lib/db/queries/umap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_HEADERS = {
  // Recomputes are on-demand; the public endpoint can safely cache at the CDN
  // for a short window so a popular /map page doesn't hammer the DB.
  'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300'
};

export async function GET() {
  const row = await latestProjection();
  if (!row) {
    return NextResponse.json({ points: [], createdAt: null }, { headers: CACHE_HEADERS });
  }
  // points is stored as jsonb; strip internal metadata for public consumers.
  return NextResponse.json(
    { points: row.points, createdAt: row.createdAt },
    { headers: CACHE_HEADERS }
  );
}
