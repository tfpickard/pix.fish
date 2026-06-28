import type { Metadata } from 'next';
import Link from 'next/link';
import { readNsfwMode } from '@/lib/nsfw';
import { hydrateNodes } from '@/lib/db/queries/daily';
import { topMagnetic } from '@/lib/db/queries/taste';
import type { PathNode } from '@/lib/knn-path-types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'taste · most magnetic',
  description: 'The gallery ranked by what pulls people -- a crowd taste leaderboard from the this-or-that.',
  alternates: { canonical: '/taste/popular' },
  robots: { index: true, follow: true }
};

function detailUrl(node: PathNode): string {
  return node.handle ? `/u/${node.handle}/${node.slug}` : `/${node.slug}`;
}

export default async function MagneticPage() {
  const nsfwMode = await readNsfwMode();
  const ranked = await topMagnetic(24, nsfwMode);
  const meta = await hydrateNodes(ranked.map((r) => r.id));
  const rows = ranked
    .map((r) => ({ ...r, node: meta.get(r.id) }))
    .filter((r): r is typeof r & { node: PathNode } => !!r.node && !!r.node.blobUrl);

  return (
    <div className="space-y-6 pt-8">
      <section className="space-y-1">
        <h1 className="font-fungal-lite text-3xl text-ink-100">most magnetic</h1>
        <p className="font-mono text-xs text-ink-500">
          the gallery ranked by what pulls people -- every{' '}
          <Link href="/taste" prefetch={false} className="text-primary hover:underline">this-or-that</Link>{' '}
          round is a vote.
        </p>
      </section>

      {rows.length === 0 ? (
        <p className="font-mono text-xs text-ink-500">
          warming up -- not enough votes yet. <Link href="/taste" prefetch={false} className="text-primary hover:underline">play the this-or-that</Link>{' '}
          to seed the ranking.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {rows.map((r, idx) => (
            <Link
              key={r.id}
              href={detailUrl(r.node)}
              title={r.node.caption || r.node.slug}
              className="group relative overflow-hidden rounded-md border border-ink-800/80 bg-ink-950 transition-colors hover:border-primary/60"
            >
              <div className="relative aspect-square overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={r.node.blobUrl}
                  alt={r.node.caption || r.node.slug}
                  className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.04]"
                />
                <span className="absolute left-1.5 top-1.5 rounded-sm border border-primary/50 bg-ink-950/80 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                  #{idx + 1}
                </span>
                <span className="absolute bottom-1.5 right-1.5 rounded-sm bg-ink-950/80 px-1.5 py-0.5 font-mono text-[9px] text-ink-300">
                  {Math.round((r.wins / r.total) * 100)}% &middot; {r.total} duels
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
