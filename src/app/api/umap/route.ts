import { NextResponse } from 'next/server';
import { latestProjection } from '@/lib/db/queries/umap';
import { loreSummaryByImageIds } from '@/lib/db/queries/lore-fragments';

export const runtime = 'nodejs';
// force-dynamic prevents static pre-render at build time (no POSTGRES_URL).
// Recomputes are on-demand; the CDN cache short-circuits repeated reads.
export const dynamic = 'force-dynamic';
export const revalidate = 60;

export async function GET() {
  const row = await latestProjection();
  if (!row) return NextResponse.json({ points: [], lore: [], createdAt: null });
  // points is stored as jsonb; strip internal metadata for public consumers.
  const points = (row.points as Array<{ imageId: number; x: number; y: number }> | null) ?? [];
  const loreMap = await loreSummaryByImageIds(points.map((p) => p.imageId)).catch(() => new Map());
  return NextResponse.json({ points: row.points, lore: [...loreMap.values()], createdAt: row.createdAt });
}
