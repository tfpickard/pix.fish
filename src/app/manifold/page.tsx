import type { Metadata } from 'next';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { images, users } from '@/lib/db/schema';
import { latestManifold } from '@/lib/db/queries/manifold';
import { countCaptionEmbeddings } from '@/lib/db/queries/embeddings';
import { loreSummaryByImageIds } from '@/lib/db/queries/lore-fragments';
import { readNsfwMode } from '@/lib/nsfw';
import { ManifoldSceneClient } from '@/components/manifold-scene-client';
import { MANIFOLD_SUBSAMPLE_CAP } from '@/lib/jobs/handlers/manifoldRecompute';

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

export default async function ManifoldPage() {
  const [row, totalEmbedded, nsfwMode] = await Promise.all([
    latestManifold(),
    countCaptionEmbeddings().catch(() => 0),
    readNsfwMode()
  ]);

  type Pt = { imageId: number; x: number; y: number; z: number };
  const points: Pt[] = (row?.points as Pt[] | null) ?? [];
  const ids = points.map((p) => p.imageId);

  // Apply the same NSFW visibility predicate used by the public gallery.
  // 'only' restricts to NSFW points; 'include' shows all; 'hide' strips NSFW.
  const nsfwFilter =
    nsfwMode === 'only'
      ? eq(images.isNsfw, true)
      : nsfwMode === 'include'
        ? undefined
        : eq(images.isNsfw, false);

  const metaRows =
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
          .where(nsfwFilter ? and(inArray(images.id, ids), nsfwFilter) : inArray(images.id, ids))
      : [];

  // "Stale" means a newer projection would incorporate more embeddings.
  // Compare against min(totalEmbedded, SUBSAMPLE_CAP): if the corpus exceeds
  // the cap the projection intentionally covers only SUBSAMPLE_CAP points and
  // that is not stale -- only genuinely new embeddings beyond what the cap
  // allowed at last run time warrant a recompute hint.
  const effectiveCap = Math.min(totalEmbedded, MANIFOLD_SUBSAMPLE_CAP);
  const stale = row ? row.pointCount < effectiveCap : totalEmbedded > 0;

  // Filter out NSFW points so they don't appear as orphaned dots with no
  // thumbnail. Build a set of visible ids from metaRows for O(1) lookup.
  const visibleIds = new Set(metaRows.map((r) => r.id));
  const visiblePoints = points.filter((p) => visibleIds.has(p.imageId));

  // Universe lore overlay for the visible specimens (best-effort).
  const loreMap =
    visibleIds.size > 0
      ? await loreSummaryByImageIds([...visibleIds]).catch(() => new Map())
      : new Map();
  const lore = [...loreMap.values()];

  return (
    <div className="space-y-4 pt-8">
      <h1 className="font-fungal-lite text-3xl text-ink-100">manifold</h1>
      <p className="font-mono text-xs text-ink-500">
        3D semantic point cloud. each dot is an image; position reflects caption-embedding
        similarity projected via UMAP to 3 dimensions.
      </p>
      <ManifoldSceneClient points={visiblePoints} images={metaRows} lore={lore} />
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
