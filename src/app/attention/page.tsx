import type { Metadata } from 'next';
import Link from 'next/link';
import { readNsfwMode } from '@/lib/nsfw';
import { getTopAttention, type DwellMode } from '@/lib/db/queries/attention';
import { getTopPathsVisible } from '@/lib/db/queries/path-traffic';
import { getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';
import { ImageGrid } from '@/components/image-grid';

// Public "most looked at" board. Surfaces the anonymous, aggregate dwell
// telemetry that until now only nudged the drift sort: which images the
// collection actually lingers on. Two views -- 'hot' (live, 3-day decayed) and
// 'lifetime' (all-time handling total). NSFW visibility follows the visitor's
// cookie exactly as the gallery does (gated inside the query, never shipped).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'most looked at',
  description:
    'The images the collection dwells on, ranked by anonymous, aggregate attention.',
  // Both ?mode= variants are the same board; without this the route inherits
  // the root layout's canonical of '/' and search engines fold it into home.
  alternates: { canonical: '/attention' }
};

const BOARD_SIZE = 48;
const PATHS_SIZE = 10;

function parseMode(raw: string | undefined): DwellMode {
  return raw === 'lifetime' ? 'lifetime' : 'hot';
}

export default async function AttentionPage({
  searchParams
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const mode = parseMode((await searchParams)?.mode);
  const nsfwMode = await readNsfwMode();

  const [ranked, paths] = await Promise.all([
    getTopAttention({ mode, limit: BOARD_SIZE, nsfwMode }).catch(() => []),
    getTopPathsVisible(PATHS_SIZE, nsfwMode).catch(() => [])
  ]);

  // Ranked ids -> hydrated cards, preserving the leaderboard order.
  const rows = ranked.length > 0 ? await getImagesByIdsOrdered(ranked.map((r) => r.imageId)) : [];
  const images = await hydrateImages(rows);

  const tabClass = (active: boolean) =>
    `font-mono text-xs uppercase tracking-wider transition-colors ${
      active ? 'text-ink-100' : 'text-ink-500 hover:text-ink-300'
    }`;

  return (
    <div className="space-y-10 pt-8">
      <header className="mx-auto max-w-2xl space-y-3 text-center">
        <h1 className="font-display text-3xl text-ink-100">most looked at</h1>
        <p className="font-mono text-xs text-ink-500">
          the collection watches back. these are the records it dwells on -- measured anonymously,
          in aggregate, from time on screen.
        </p>
        <nav className="flex items-center justify-center gap-4 pt-1">
          <Link href="/attention?mode=hot" prefetch={false} className={tabClass(mode === 'hot')}>
            hot now
          </Link>
          <span className="text-ink-700">/</span>
          <Link
            href="/attention?mode=lifetime"
            prefetch={false}
            className={tabClass(mode === 'lifetime')}
          >
            all-time
          </Link>
        </nav>
        {mode === 'lifetime' ? (
          // The lifetime ledger only began accumulating when dwell logging
          // shipped -- earlier views were never recorded per-image, so this is
          // an all-time total from that point on, not the gallery's full past.
          <p className="font-mono text-xs text-ink-600">
            counted since dwell logging began -- earlier views aren&apos;t included
          </p>
        ) : null}
      </header>

      {images.length === 0 ? (
        <p className="py-24 text-center font-mono text-sm text-ink-500">
          no attention recorded yet -- come back once the collection has been looked at.
        </p>
      ) : (
        // Known limitation: ImageCard links to the legacy /<slug> and its
        // reaction controls hit slug-scoped routes, which resolve the admin-or-
        // oldest owner when two owners share a slug. This is app-wide ImageCard
        // behavior (gallery, search, neighbors all share it), not specific to
        // this board; making it owner-exact needs image-id-scoped reaction
        // routes, tracked separately. The worn-path links below are already
        // owner-scoped since they are bespoke to this page.
        <ImageGrid images={images} />
      )}

      {paths.length > 0 ? (
        <section className="mx-auto max-w-2xl space-y-3 border-t border-ink-800/60 pt-8">
          <h2 className="text-center font-mono text-xs uppercase tracking-wider text-ink-500">
            worn paths
          </h2>
          <p className="text-center font-mono text-xs text-ink-600">
            the image-to-image routes visitors walk most
          </p>
          <ul className="space-y-1.5 pt-2">
            {paths.map((p) => (
              <li
                key={`${p.srcId}:${p.dstId}`}
                className="flex items-center justify-center gap-2 font-mono text-xs text-ink-400"
              >
                <Link
                  href={`/u/${p.srcHandle}/${p.srcSlug}`}
                  prefetch={false}
                  className="truncate hover:text-ink-100"
                >
                  {p.srcSlug}
                </Link>
                <span className="text-ink-600">&rarr;</span>
                <Link
                  href={`/u/${p.dstHandle}/${p.dstSlug}`}
                  prefetch={false}
                  className="truncate hover:text-ink-100"
                >
                  {p.dstSlug}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
