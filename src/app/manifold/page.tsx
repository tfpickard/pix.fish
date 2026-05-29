import type { Metadata } from 'next';
import dynamicImport from 'next/dynamic';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { images, users } from '@/lib/db/schema';
import { latestManifold } from '@/lib/db/queries/manifold';
import { countCaptionEmbeddings } from '@/lib/db/queries/embeddings';

// App Router segment config -- force-dynamic prevents static pre-render at
// build time when POSTGRES_URL is absent, and keeps projection data fresh.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Visualization, not content -- keep crawlable but don't index.
export const metadata: Metadata = {
  title: 'manifold',
  description: '3D semantic point cloud of the pix.fish gallery by caption-embedding similarity.',
  alternates: { canonical: '/manifold' },
  robots: { index: false, follow: true }
};

// Three.js has no SSR-safe path in Next 14 App Router. The component imports
// WebGL APIs at module load, so we must skip SSR entirely.
const ManifoldScene = dynamicImport(
  () => import('@/components/manifold-scene').then((m) => m.ManifoldScene),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[600px] items-center justify-center rounded border border-ink-800 bg-ink-950 font-mono text-xs text-ink-500">
        loading scene...
      </div>
    )
  }
);

export default async function ManifoldPage() {
  const [row, totalEmbedded] = await Promise.all([
    latestManifold(),
    countCaptionEmbeddings().catch(() => 0)
  ]);

  type Pt = { imageId: number; x: number; y: number; z: number };
  const points: Pt[] = (row?.points as Pt[] | null) ?? [];
  const ids = points.map((p) => p.imageId);

  const metaRows =
    ids.length > 0
      ? await db
          .select({
            id: images.id,
            slug: images.slug,
            handle: users.handle,
            blobUrl: images.blobUrl,
            palette: images.palette
          })
          .from(images)
          .innerJoin(users, eq(users.id, images.ownerId))
          .where(inArray(images.id, ids))
      : [];

  const stale = row ? row.pointCount < totalEmbedded : totalEmbedded > 0;

  return (
    <div className="space-y-4 pt-8">
      <h1 className="font-fungal-lite text-3xl text-ink-100">manifold</h1>
      <p className="font-mono text-xs text-ink-500">
        3D semantic point cloud. each dot is an image; position reflects caption-embedding
        similarity projected via UMAP to 3 dimensions.
      </p>
      <ManifoldScene points={points} images={metaRows} />
      {row ? (
        <p className="font-mono text-xs text-ink-500">
          {row.pointCount} of {totalEmbedded} points
          {stale ? ' · stale' : ''} &middot; seed {row.seed} &middot; last computed{' '}
          {new Date(row.createdAt).toLocaleString()}
        </p>
      ) : totalEmbedded > 0 ? (
        <p className="font-mono text-xs text-ink-500">
          no projection yet for {totalEmbedded} embedded image{totalEmbedded === 1 ? '' : 's'}
        </p>
      ) : null}
    </div>
  );
}
