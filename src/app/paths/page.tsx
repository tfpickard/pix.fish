import type { Metadata } from 'next';
import Link from 'next/link';
import { readNsfwMode } from '@/lib/nsfw';
import { listDesirePaths } from '@/lib/db/queries/desire-paths';
import { hydrateVisibleNodeMap } from '@/lib/db/queries/path-hydrate';
import type { PathNode } from '@/lib/knn-path-types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'desire paths',
  description: 'Corridors visitors have worn into the similarity graph by walking them repeatedly.',
  alternates: { canonical: '/paths' },
  robots: { index: false, follow: true }
};

// How many complete cards the page aims to show, and how deep into the
// strength-ordered list we look to find them (listDesirePaths caps at 500).
const CARDS_SHOWN = 100;
const CANDIDATE_POOL = 400;

export default async function DesirePathsIndex() {
  const nsfwMode = await readNsfwMode();

  // Over-fetch the candidate pool, then select the strongest CARDS_SHOWN that
  // are fully visible. Fetching exactly the top 100 and filtering afterwards
  // meant a visitor whose NSFW mode hid those routes saw a short page -- or an
  // empty "no desire paths yet" -- while perfectly visible weaker corridors sat
  // just past the cutoff. Hydration is one batched query regardless of pool
  // size, so the wider pool costs a single larger IN(...) rather than N queries.
  const paths = await listDesirePaths({ limit: CANDIDATE_POOL });

  const allIds = [...new Set(paths.flatMap((p) => p.nodeIds as number[]))];
  const nodeMap = await hydrateVisibleNodeMap(allIds, nsfwMode);

  // A route is renderable only if all of its stops are visible to this visitor;
  // a corridor with a hidden stop would leak a gap (or a blob URL) so we skip it
  // wholesale rather than render a partial chain.
  const cards = paths
    .map((p) => {
      const ids = p.nodeIds as number[];
      const nodes = ids.map((id) => nodeMap.get(id)).filter((n): n is PathNode => !!n);
      return { path: p, nodes, complete: nodes.length === ids.length && nodes.length >= 2 };
    })
    .filter((c) => c.complete)
    .slice(0, CARDS_SHOWN);

  return (
    <div className="space-y-8 pt-8">
      <section className="space-y-2">
        <h1 className="font-fungal-lite text-3xl text-ink-100">desire paths</h1>
        <p className="font-mono text-xs text-ink-500">
          corridors visitors have worn into the similarity graph by walking them, not routes
          anyone laid out. the strongest are promoted here; when a path stops being walked it is
          quietly retired.
        </p>
      </section>

      {cards.length === 0 ? (
        <p className="font-mono text-xs text-ink-500">
          no desire paths yet -- they emerge once visitors have walked enough journeys through{' '}
          <Link href="/connect" className="underline hover:text-ink-300">
            /connect
          </Link>{' '}
          for corridors to form.
        </p>
      ) : (
        <ul className="space-y-6">
          {cards.map(({ path, nodes }) => (
            <li key={path.id} className="space-y-2">
              <Link href={`/path/${path.slug}`} className="group block space-y-2">
                <div className="flex items-baseline justify-between gap-4">
                  <h2 className="font-fungal-lite text-lg text-ink-200 group-hover:text-ink-100">
                    {path.caption ?? path.slug}
                  </h2>
                  <span className="shrink-0 font-mono text-[10px] text-ink-600">
                    {nodes.length} stops &middot; strength {path.strength.toFixed(1)}
                  </span>
                </div>
                {/* Thumbnail run -- a preview of the corridor. */}
                <div className="flex flex-wrap gap-2">
                  {nodes.map((node) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={node.imageId}
                      src={node.blobUrl}
                      alt={node.caption}
                      width={64}
                      height={64}
                      className="rounded border border-ink-800 object-cover transition group-hover:border-ink-600"
                      style={{ width: 64, height: 64 }}
                    />
                  ))}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
