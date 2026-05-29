import type { Metadata } from 'next';
import Link from 'next/link';
import { eq, inArray, asc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { images, captions, users } from '@/lib/db/schema';
import { countKnnEdges, getEdgesForNodes, getEdgesForNodesExcludingNsfw } from '@/lib/db/queries/knn';
import { getCaptionVector } from '@/lib/db/queries/embeddings';
import { findPath } from '@/lib/knn';
import { readNsfwMode } from '@/lib/nsfw';
import { PathFilmstrip } from '@/components/path-filmstrip';
import type { PathNode } from '@/lib/knn-path-types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'connect',
  description: 'Find the shortest path between two images through the semantic similarity graph.',
  alternates: { canonical: '/connect' },
  robots: { index: false, follow: true }
};

type PageProps = {
  searchParams: Promise<{ a?: string; b?: string }>;
};

type SlimImage = { id: number; slug: string; blobUrl: string };

// Resolve a raw search-param value to a slim image record. Accepts slugs
// (preferred -- human-readable) or numeric IDs (backwards compat so
// /api/path cross-links keep working). Returns null when nothing matches.
async function resolveEndpoint(raw: string): Promise<SlimImage | null> {
  if (!raw) return null;
  const [bySlug] = await db
    .select({ id: images.id, slug: images.slug, blobUrl: images.blobUrl })
    .from(images)
    .where(eq(images.slug, raw))
    .orderBy(asc(images.id))
    .limit(1);
  if (bySlug) return bySlug;
  const num = parseInt(raw, 10);
  if (!Number.isInteger(num) || num <= 0) return null;
  const [byId] = await db
    .select({ id: images.id, slug: images.slug, blobUrl: images.blobUrl })
    .from(images)
    .where(eq(images.id, num))
    .limit(1);
  return byId ?? null;
}

// Hydrate a set of image ids into PathNode records in one pair of round-trips.
// Shared with /api/path -- kept here to avoid a circular import between the
// page and the route.
async function hydratePathNodes(pathIds: number[]): Promise<PathNode[]> {
  if (pathIds.length === 0) return [];

  const [imageRows, captionRows] = await Promise.all([
    db
      .select({ id: images.id, slug: images.slug, blobUrl: images.blobUrl, ownerId: images.ownerId })
      .from(images)
      .where(inArray(images.id, pathIds)),
    db
      .select({ imageId: captions.imageId, text: captions.text, isSlugSource: captions.isSlugSource, variant: captions.variant })
      .from(captions)
      .where(inArray(captions.imageId, pathIds))
      .orderBy(asc(captions.imageId), asc(captions.variant))
  ]);

  const ownerIds = [...new Set(imageRows.map((r) => r.ownerId))];
  const userRows =
    ownerIds.length > 0
      ? await db
          .select({ id: users.id, handle: users.handle })
          .from(users)
          .where(inArray(users.id, ownerIds))
      : [];

  const handleByOwner = new Map(userRows.map((u) => [u.id, u.handle]));
  const imageById = new Map(imageRows.map((r) => [r.id, r]));

  // Pick the canonical caption: prefer isSlugSource=true, then lowest variant.
  // captionRows are already sorted by (imageId ASC, variant ASC).
  const captionByImage = new Map<number, string>();
  for (const c of captionRows) {
    if (!captionByImage.has(c.imageId)) {
      captionByImage.set(c.imageId, c.text);
    } else if (c.isSlugSource) {
      captionByImage.set(c.imageId, c.text);
    }
  }

  return pathIds.map((id) => {
    const img = imageById.get(id);
    return {
      imageId: id,
      slug: img?.slug ?? '',
      blobUrl: img?.blobUrl ?? '',
      handle: handleByOwner.get(img?.ownerId ?? '') ?? '',
      caption: captionByImage.get(id) ?? img?.slug ?? ''
    };
  });
}

type PathOutcome =
  | { status: 'found'; nodes: PathNode[]; totalDist: number }
  | { status: 'same-node' }
  | { status: 'no-path' }
  | { status: 'missing-embedding' }
  | { status: 'bad-ids' };

async function resolvePath(a: number, b: number, includeNsfw: boolean): Promise<PathOutcome> {
  if (a === b) return { status: 'same-node' };

  // Verify both images exist before running Dijkstra.
  const existCheck = await db
    .select({ id: images.id })
    .from(images)
    .where(inArray(images.id, [a, b]));
  const existIds = new Set(existCheck.map((r) => r.id));
  if (!existIds.has(a) || !existIds.has(b)) return { status: 'bad-ids' };

  // Check both endpoints have a caption embedding. An image with no embedding
  // was never added to the kNN graph, so the real reason for no path is a
  // missing embedding, not graph disconnection. Surface the precise status
  // so users get the right remediation message.
  const [vecA, vecB] = await Promise.all([getCaptionVector(a), getCaptionVector(b)]);
  if (!vecA || !vecB) return { status: 'missing-embedding' };

  // Route Dijkstra through a filtered edge loader when the visitor has not
  // opted in to NSFW content. This excludes NSFW nodes from both the search
  // and the reconstructed path rather than just hiding them post-hoc.
  const edgeLoader = includeNsfw ? getEdgesForNodes : getEdgesForNodesExcludingNsfw;

  const result = await findPath(a, b, edgeLoader);
  if (!result.found) {
    return { status: result.reason };
  }

  const nodes = await hydratePathNodes(result.path);
  return { status: 'found', nodes, totalDist: result.totalDist };
}

export default async function ConnectPage({ searchParams }: PageProps) {
  const { a: rawA = '', b: rawB = '' } = await searchParams;

  // Resolve slugs (or fallback numeric IDs) to slim image records in parallel.
  const [imgA, imgB, edgeCount, nsfwMode] = await Promise.all([
    resolveEndpoint(rawA),
    resolveEndpoint(rawB),
    countKnnEdges().catch(() => 0),
    readNsfwMode()
  ]);

  const hasValidParams = !!(imgA && imgB);
  const graphReady = edgeCount > 0;
  const includeNsfw = nsfwMode !== 'hide';

  let outcome: PathOutcome | null = null;
  if (hasValidParams && graphReady) {
    outcome = await resolvePath(imgA.id, imgB.id, includeNsfw).catch((err) => {
      console.error('/connect: resolvePath error', err);
      return null;
    });
  }

  return (
    <div className="space-y-8 pt-8">
      <section className="space-y-2">
        <h1 className="font-fungal-lite text-3xl text-ink-100">connect</h1>
        <p className="font-mono text-xs text-ink-500">
          find the shortest path between two images through the semantic similarity graph. paste
          a slug from any image page into each field below.
        </p>
      </section>

      {/* Graph not-ready warning */}
      {!graphReady ? (
        <div className="rounded border border-amber-700/40 bg-amber-900/10 p-4">
          <p className="font-mono text-xs text-amber-400">
            the knn graph has not been built yet. a site admin can trigger a rebuild at{' '}
            <Link href="/admin/knn" className="underline hover:text-amber-300">
              /admin/knn
            </Link>
            .
          </p>
        </div>
      ) : null}

      {/* Picker form. GET so the result URL is shareable. */}
      <form method="GET" action="/connect" className="flex flex-wrap items-end gap-4">
        {/* Endpoint A */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="a" className="font-mono text-[10px] uppercase tracking-wider text-ink-500">
            image A
          </label>
          {imgA ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgA.blobUrl}
              alt={imgA.slug}
              width={72}
              height={72}
              className="rounded border border-ink-700 object-cover"
              style={{ width: 72, height: 72 }}
            />
          ) : rawA ? (
            <div className="flex items-center justify-center rounded border border-red-800/50 bg-red-950/20" style={{ width: 72, height: 72 }}>
              <span className="font-mono text-[9px] text-red-400">not found</span>
            </div>
          ) : null}
          <input
            id="a"
            name="a"
            type="text"
            defaultValue={imgA?.slug ?? rawA}
            placeholder="slug..."
            autoComplete="off"
            className="w-44 rounded border border-ink-700 bg-ink-900 px-3 py-1.5 font-mono text-xs text-ink-100 placeholder-ink-600 focus:border-primary/60 focus:outline-none"
          />
        </div>

        <span className="mb-1.5 font-mono text-xs text-ink-600 self-end">to</span>

        {/* Endpoint B */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="b" className="font-mono text-[10px] uppercase tracking-wider text-ink-500">
            image B
          </label>
          {imgB ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgB.blobUrl}
              alt={imgB.slug}
              width={72}
              height={72}
              className="rounded border border-ink-700 object-cover"
              style={{ width: 72, height: 72 }}
            />
          ) : rawB ? (
            <div className="flex items-center justify-center rounded border border-red-800/50 bg-red-950/20" style={{ width: 72, height: 72 }}>
              <span className="font-mono text-[9px] text-red-400">not found</span>
            </div>
          ) : null}
          <input
            id="b"
            name="b"
            type="text"
            defaultValue={imgB?.slug ?? rawB}
            placeholder="slug..."
            autoComplete="off"
            className="w-44 rounded border border-ink-700 bg-ink-900 px-3 py-1.5 font-mono text-xs text-ink-100 placeholder-ink-600 focus:border-primary/60 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-3 self-end">
          <button
            type="submit"
            className="rounded border border-primary/50 bg-primary/10 px-4 py-1.5 font-mono text-xs text-primary hover:bg-primary/20"
          >
            find path
          </button>
          {hasValidParams || rawA || rawB ? (
            <Link href="/connect" className="font-mono text-xs text-ink-500 hover:text-ink-300">
              clear
            </Link>
          ) : null}
        </div>
      </form>

      {/* Result */}
      {hasValidParams && graphReady ? (
        <section className="space-y-4">
          {outcome === null ? (
            <p className="font-mono text-xs text-red-400">
              could not resolve path -- server error.
            </p>
          ) : outcome.status === 'found' ? (
            <PathFilmstrip path={outcome.nodes} totalDist={outcome.totalDist} />
          ) : outcome.status === 'same-node' ? (
            <p className="font-mono text-xs text-ink-400">
              A and B are the same image -- pick two different ones.
            </p>
          ) : outcome.status === 'bad-ids' ? (
            <p className="font-mono text-xs text-ink-400">
              one or both images not found.
            </p>
          ) : outcome.status === 'no-path' ? (
            <p className="font-mono text-xs text-ink-400">
              no path found between{' '}
              <span className="text-ink-300">{imgA.slug}</span> and{' '}
              <span className="text-ink-300">{imgB.slug}</span>. the graph may have disconnected
              components -- images without a caption embedding share no edges.
            </p>
          ) : outcome.status === 'missing-embedding' ? (
            <p className="font-mono text-xs text-ink-400">
              one or both images have no caption embedding yet -- run enrichment then rebuild the
              knn graph.
            </p>
          ) : null}
        </section>
      ) : rawA && !imgA ? (
        <p className="font-mono text-xs text-ink-500">no image found for slug &ldquo;{rawA}&rdquo;.</p>
      ) : rawB && !imgB ? (
        <p className="font-mono text-xs text-ink-500">no image found for slug &ldquo;{rawB}&rdquo;.</p>
      ) : hasValidParams && !graphReady ? (
        <p className="font-mono text-xs text-ink-500">build the graph first, then try again.</p>
      ) : null}

      {/* Graph stats footer */}
      {graphReady ? (
        <p className="font-mono text-xs text-ink-600">
          graph: {edgeCount.toLocaleString()} directed edges &middot;{' '}
          <Link href="/admin/knn" className="hover:text-ink-400">
            rebuild
          </Link>
        </p>
      ) : null}

      {/*
        MANIFOLD INTEGRATION SEAM (deferred, pending feat/manifold merge)
        ------------------------------------------------------------------
        When feat/manifold is merged, add a ManifoldScene here with a
        `highlightPath` prop. The component needs:
          - outcome.status === 'found' && outcome.nodes.map(n => n.imageId)
          - The 3D manifold projection (latestManifoldProjection() call)
        PathFilmstrip already exports `extractPathImageIds(nodes)` as a
        convenience. No changes to this page's data-fetching are needed.

        import { ManifoldScene } from '@/components/manifold-scene';
        import { extractPathImageIds } from '@/components/path-filmstrip';
        // ...
        {outcome?.status === 'found' ? (
          <ManifoldScene highlightPath={extractPathImageIds(outcome.nodes)} />
        ) : null}
      */}
    </div>
  );
}
