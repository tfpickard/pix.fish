import type { Metadata } from 'next';
import { inArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { images } from '@/lib/db/schema';
import { latestProjection } from '@/lib/db/queries/umap';
import { UmapCanvas } from '@/components/umap-canvas';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Visualization, not content. Keep crawlable for link equity but don't index.
export const metadata: Metadata = {
  title: 'map',
  description: 'UMAP projection of the pix.fish gallery by caption-embedding similarity.',
  alternates: { canonical: '/map' },
  robots: { index: false, follow: true }
};

export default async function MapPage() {
  const row = await latestProjection();
  type Pt = { imageId: number; x: number; y: number };
  const points: Pt[] = (row?.points as Pt[] | null) ?? [];
  const ids = points.map((p) => p.imageId);
  const metaRows =
    ids.length > 0
      ? await db.select({ id: images.id, slug: images.slug }).from(images).where(inArray(images.id, ids))
      : [];

  return (
    <div className="space-y-4 pt-8">
      <h1 className="font-fungal-lite text-3xl text-ink-100">map</h1>
      <p className="font-mono text-xs text-ink-500">
        semantic cluster view. each dot is an image; position reflects caption-embedding
        similarity. projected via UMAP.
      </p>
      <UmapCanvas points={points} images={metaRows} />
      {row ? (
        <p className="font-mono text-xs text-ink-500">
          {row.pointCount} points -- last computed {new Date(row.createdAt).toLocaleString()}
        </p>
      ) : null}
    </div>
  );
}
