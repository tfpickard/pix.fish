import type { Metadata } from 'next';
import { auth, isSiteAdmin } from '@/lib/auth';
import { readNsfwMode } from '@/lib/nsfw';
import { hydrateNodes } from '@/lib/db/queries/daily';
import { getRandomEmbeddedImageIds } from '@/lib/db/queries/taste';
import { activeFuseIds } from '@/lib/db/queries/fuse';
import { FuseBoard } from '@/components/fuse-board';
import type { PathNode } from '@/lib/knn-path-types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'fuse',
  description:
    'Image alchemy: combine two images and discover the one that lives between them. Fuse your discoveries into new ones and grow a tree of surreal specimens -- a shareable board you can hand to a friend.',
  alternates: { canonical: '/fuse' },
  robots: { index: true, follow: true }
};

const SEED_COUNT = 8;
const MAX_BOARD = 60;

function parseIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(-MAX_BOARD);
}

type PageProps = {
  searchParams: Promise<{ have?: string }>;
};

export default async function FusePage({ searchParams }: PageProps) {
  const { have: rawHave } = await searchParams;
  const nsfwMode = await readNsfwMode();
  // Only the owner/admin can spend on a live gpt-image-2 render (the button is
  // hidden for everyone else; /api/fuse/render enforces this server-side too).
  const isAdmin = isSiteAdmin(await auth());

  // ---- Shared board: ?have=12,45,... restores someone's collection. Filter
  // through the active+embedded+visible set first so a crafted id list can't put
  // a hidden image on the board, then hydrate (preserving order).
  const haveIds = parseIds(rawHave);
  if (haveIds.length > 0) {
    const allowed = await activeFuseIds(haveIds, nsfwMode);
    const ordered = haveIds.filter((id) => allowed.has(id));
    if (ordered.length >= 2) {
      const meta = await hydrateNodes(ordered);
      const inventory = ordered.map((id) => meta.get(id)).filter((n): n is PathNode => !!n && !!n.blobUrl);
      if (inventory.length >= 2) {
        return <FuseBoard key={`have:${nsfwMode}:${ordered.join(',')}`} initial={inventory} isAdmin={isAdmin} />;
      }
    }
  }

  // ---- Fresh: seed a small starting inventory of random visible specimens.
  const ids = await getRandomEmbeddedImageIds(SEED_COUNT, nsfwMode);
  const meta = await hydrateNodes(ids);
  const inventory = ids.map((id) => meta.get(id)).filter((n): n is PathNode => !!n && !!n.blobUrl);

  if (inventory.length < 2) {
    return (
      <div className="space-y-4 pt-8">
        <h1 className="font-fungal-lite text-3xl text-ink-100">fuse</h1>
        <p className="font-mono text-xs text-ink-500">
          not enough images yet to fuse -- check back once more have been added.
        </p>
      </div>
    );
  }

  // key by the seed ids AND the NSFW mode so a fresh load / cookie change starts
  // a clean, re-gated board instead of reusing a previous instance's state.
  return <FuseBoard key={`seed:${nsfwMode}:${ids.join(',')}`} initial={inventory} isAdmin={isAdmin} />;
}
