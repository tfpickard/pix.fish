import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readNsfwMode } from '@/lib/nsfw';
import { getActiveDesirePathBySlug } from '@/lib/db/queries/desire-paths';
import { hydrateRouteNodes, detailUrl } from '@/lib/db/queries/path-hydrate';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type PageProps = {
  params: Promise<{ slug: string }>;
};

// A desire path is not indexable: it is a live artifact of traffic that the
// promote job retires as soon as the corridor stops being walked, so a stable
// canonical entry in search would routinely 404.
export const metadata: Metadata = {
  robots: { index: false, follow: true }
};

export default async function DesirePathPage({ params }: PageProps) {
  const { slug } = await params;
  const nsfwMode = await readNsfwMode();

  const path = await getActiveDesirePathBySlug(slug);
  if (!path) notFound();

  const { nodes } = await hydrateRouteNodes(path.nodeIds as number[], nsfwMode);
  // A corridor needs at least two visible stops to be a walkable route. If the
  // visitor's NSFW mode hides too many stops, treat it as not found rather than
  // rendering a stub -- the same posture /connect takes with hidden endpoints.
  if (nodes.length < 2) notFound();

  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const walkHref = `/connect?a=${encodeURIComponent(first.slug)}&b=${encodeURIComponent(last.slug)}`;

  return (
    <div className="space-y-8 pt-8">
      <section className="space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-wider text-ink-600">desire path</p>
        <h1 className="font-fungal-lite text-3xl text-ink-100">{path.caption ?? path.slug}</h1>
        <p className="font-mono text-xs text-ink-500">
          a right of way established by use -- {nodes.length} stops, worn in by repeat traffic
          rather than laid out. strength {path.strength.toFixed(1)} &middot; lifetime{' '}
          {path.lifetime.toFixed(1)}
        </p>
      </section>

      {/* Ordered filmstrip of stops. Lightweight (no shared JourneyPlayer) --
          full playback lives behind the "walk this corridor" link below. */}
      <ol className="flex flex-wrap gap-3">
        {nodes.map((node, i) => (
          <li key={node.imageId} className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] text-ink-600">{i + 1}</span>
            <Link href={detailUrl(node)} className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={node.blobUrl}
                alt={node.caption}
                width={104}
                height={104}
                className="rounded border border-ink-700 object-cover transition hover:border-primary/60"
                style={{ width: 104, height: 104 }}
              />
            </Link>
            <span className="w-[104px] truncate font-mono text-[10px] text-ink-500" title={node.caption}>
              {node.caption}
            </span>
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-4">
        <Link
          href={walkHref}
          prefetch={false}
          className="rounded border border-primary/50 bg-primary/10 px-4 py-1.5 font-mono text-xs text-primary hover:bg-primary/20"
        >
          walk this corridor &#10022;
        </Link>
        <Link href="/paths" className="font-mono text-xs text-ink-500 hover:text-ink-300">
          all desire paths
        </Link>
      </div>
    </div>
  );
}
