import { NextResponse } from 'next/server';
import { latestProjection } from '@/lib/db/queries/umap';

export const runtime = 'nodejs';
// Recomputes are on-demand; the public endpoint can safely cache at the CDN
// for a short window so a popular /map page doesn't hammer the DB.
export const revalidate = 60;

export async function GET() {
  const row = await latestProjection();
  if (!row) return NextResponse.json({ points: [], createdAt: null });
  // points is stored as jsonb; strip internal metadata for public consumers.
  return NextResponse.json({ points: row.points, createdAt: row.createdAt });
}
