import { NextResponse } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { images, users } from '@/lib/db/schema';
import { latestManifold } from '@/lib/db/queries/manifold';

export const runtime = 'nodejs';
// force-dynamic prevents Next.js from attempting static pre-render at build
// time when POSTGRES_URL is absent. Recomputes are on-demand so we want fresh
// data on each request anyway; revalidate=60 adds a short CDN cache.
export const dynamic = 'force-dynamic';
export const revalidate = 60;

export type ManifoldImageMeta = {
  id: number;
  slug: string;
  handle: string;
  blobUrl: string;
  palette: string[] | null;
  surprisal: number | null;
};

export async function GET() {
  const row = await latestManifold();
  if (!row) {
    return NextResponse.json({ points: [], images: [], createdAt: null, seed: null });
  }

  type Pt = { imageId: number; x: number; y: number; z: number };
  const points = row.points as Pt[];
  const ids = points.map((p) => p.imageId);

  // Join with users to get the handle so the client can build /u/<handle>/<slug>
  // without a second round-trip.
  const metaRows: ManifoldImageMeta[] =
    ids.length > 0
      ? await db
          .select({
            id: images.id,
            slug: images.slug,
            handle: users.handle,
            blobUrl: images.blobUrl,
            palette: images.palette,
            surprisal: images.surprisal
          })
          .from(images)
          .innerJoin(users, eq(users.id, images.ownerId))
          .where(inArray(images.id, ids))
      : [];

  return NextResponse.json({
    points,
    images: metaRows,
    createdAt: row.createdAt,
    seed: row.seed,
    pointCount: row.pointCount
  });
}
