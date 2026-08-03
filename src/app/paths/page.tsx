import type { Metadata } from 'next';
import Link from 'next/link';
import { readNsfwMode } from '@/lib/nsfw';
import { listDesirePaths } from '@/lib/db/queries/desire-paths';
import { hydrateVisibleNodeMap } from '@/lib/db/queries/path-hydrate';
import type { PathNode } from '@/lib/knn-path-types';
import type { DesirePath } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'desire paths',
  description: 'Corridors visitors have worn into the similarity graph by walking them repeatedly.',
  alternates: { canonical: '/paths' },
  robots: { index: false, follow: true }
};

// How many complete cards the page aims to show, how many routes we pull per
// scan step, and how deep into the strength-ordered list we are willing to go.
const CARDS_SHOWN = 100;
const SCAN_PAGE = 200;
const SCAN_LIMIT = 1000;

export default async function DesirePathsIndex() {
  const nsfwMode = await readNsfwMode();

  // Scan the strength-ordered list until we have enough fully visible cards,
  // rather than filtering a fixed pool. Visibility is decided per visitor after
  // hydration, so any fixed pool has a depth past which the page lies: a
  // visitor whose mode hides the whole pool saw "no desire paths yet" while
  // visible corridors sat one row beyond the cutoff. Paging keeps the common
  // case at one round-trip and only digs deeper for the visitors who need it.
  const cards: { path: DesirePath; nodes: PathNode[] }[] = [];

  for (let offset = 0; offset < SCAN_LIMIT && cards.length < CARDS_SHOWN; offset += SCAN_PAGE) {
    const pageRows = await listDesirePaths({ limit: SCAN_PAGE, offset });
    if (pageRows.length === 0) break;

    const ids = [...new Set(pageRows.flatMap((p) => p.nodeIds as number[]))];
    const nodeMap = await hydrateVisibleNodeMap(ids, nsfwMode);

    for (const p of pageRows) {
      if (cards.length >= CARDS_SHOWN) break;
      // A route is renderable only if all of its stops are visible to this
      // visitor; a corridor with a hidden stop would leak a gap (or a blob URL)
      // so we skip it wholesale rather than render a partial chain.
      const nodeIds = p.nodeIds as number[];
      const nodes = nodeIds.map((id) => nodeMap.get(id)).filter((n): n is PathNode => !!n);
      if (nodes.length === nodeIds.length && nodes.length >= 2) cards.push({ path: p, nodes });
    }

    if (pageRows.length < SCAN_PAGE) break; // exhausted the table
  }

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
