import type { Metadata } from 'next';
import { readNsfwMode } from '@/lib/nsfw';
import { hydrateNodes } from '@/lib/db/queries/daily';
import { seedDriftImage, activeDriftIds } from '@/lib/db/queries/drift';
import { latestProjection } from '@/lib/db/queries/umap';
import { DriftPlayer } from '@/components/drift-player';
import type { PathNode } from '@/lib/knn-path-types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'drift',
  description:
    'Fall through the gallery: a steerable, never-repeating walk through the embedding graph. Pull toward what draws you, push away what does not, dial how far reality dissolves -- and surface with a drift you can share.',
  alternates: { canonical: '/drift' },
  robots: { index: true, follow: true }
};

const MAX_REPLAY = 200;

function parseIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, MAX_REPLAY);
}

type PageProps = {
  searchParams: Promise<{ from?: string; d?: string }>;
};

export default async function DriftPage({ searchParams }: PageProps) {
  const { from: rawFrom, d: rawD } = await searchParams;
  const nsfwMode = await readNsfwMode();

  // Atlas projection (newest) backs the live comet-trail minimap. Optional --
  // if no projection exists yet the player just hides the map.
  const projection = await latestProjection().catch(() => null);
  const points = Array.isArray(projection?.points) ? projection!.points : [];

  // ---- Replay / branch: a shared drift URL (?d=12,45,...) reproduces the exact
  // sequence. Filter through the active+embedded+NSFW set first so a crafted id
  // list can't smuggle a hidden image into playback, then preserve order.
  const replayIds = parseIds(rawD);
  if (replayIds.length >= 2) {
    const allowed = await activeDriftIds(replayIds, nsfwMode);
    const ordered = replayIds.filter((id) => allowed.has(id));
    if (ordered.length >= 2) {
      const meta = await hydrateNodes(ordered);
      const nodes = ordered.map((id) => meta.get(id)).filter((n): n is PathNode => !!n && !!n.blobUrl);
      if (nodes.length >= 2) {
        return <DriftPlayer initial={nodes} replay points={points} />;
      }
    }
  }

  // ---- Fresh (or branch from ?from=<id>): seed one valid start image and fall.
  const fromId = parseIds(rawFrom)[0] ?? null;
  const seedId = await seedDriftImage(fromId, nsfwMode);
  if (seedId === null) {
    return (
      <div className="space-y-4 pt-8">
        <h1 className="font-fungal-lite text-3xl text-ink-100">drift</h1>
        <p className="font-mono text-xs text-ink-500">
          not enough images yet to drift -- check back once more have been added.
        </p>
      </div>
    );
  }
  const meta = await hydrateNodes([seedId]);
  const seed = meta.get(seedId);
  if (!seed || !seed.blobUrl) {
    return (
      <div className="space-y-4 pt-8">
        <h1 className="font-fungal-lite text-3xl text-ink-100">drift</h1>
        <p className="font-mono text-xs text-ink-500">couldn&rsquo;t open the deep just now -- try again.</p>
      </div>
    );
  }
  return <DriftPlayer initial={[seed]} points={points} />;
}
