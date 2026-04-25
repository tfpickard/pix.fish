import type { Metadata } from 'next';
import { listImages } from '@/lib/db/queries/images';
import { tagCloud } from '@/lib/db/queries/tags';
import { getGalleryDefaults } from '@/lib/db/queries/gallery-config';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { readShowNsfwCookie } from '@/lib/nsfw';
import { HAIKUS } from '@/lib/haikus';
import { pickOne } from '@/lib/random';
import { ImageGrid } from '@/components/image-grid';
import { TagCloud } from '@/components/tag-cloud';
import { SortBar } from '@/components/sort-bar';
import { isSortMode } from '@/lib/sort/types';
import { JsonLd } from '@/components/json-ld';
import { buildCollectionPageLd } from '@/lib/seo/jsonld';
import { SITE_NAME, DEFAULT_DESCRIPTION } from '@/lib/site';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// `?tag=foo` is a UI filter, not a distinct indexable page -- the real tag
// landing pages live at /tag/[tag]. The canonical alternates here point Google
// at `/` regardless of the ?tag param so filtered views don't fragment ranking.
export const metadata: Metadata = {
  title: { absolute: SITE_NAME },
  description: DEFAULT_DESCRIPTION,
  alternates: { canonical: '/' }
};

type PageProps = {
  searchParams: { tag?: string | string[]; sort?: string; seed?: string };
};

function normalizeTags(input: string | string[] | undefined): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  return [input];
}

export default async function HomePage({ searchParams }: PageProps) {
  const activeTags = normalizeTags(searchParams.tag);

  // Owner defaults feed both the server-side query (when no ?sort= is
  // present) and the client sort bar (for "(owner)" labels + reset).
  const defaults = await getGalleryDefaults(getSiteAdminId()).catch(() => ({
    defaultSort: 'drifting' as const,
    defaultShufflePeriod: 'off' as const
  }));
  const effectiveSort = isSortMode(searchParams.sort) ? searchParams.sort : defaults.defaultSort;

  const includeNsfw = await readShowNsfwCookie();

  // Fail soft: if Postgres isn't reachable, still render the shell with empty
  // data rather than crashing the whole page. Makes local dev less painful
  // and avoids a full-page error if the DB hiccups in prod.
  const [imagesRes, cloudRes] = await Promise.allSettled([
    listImages({
      limit: 60,
      tags: activeTags,
      sort: effectiveSort,
      seed: searchParams.seed,
      includeNsfw
    }),
    tagCloud(64)
  ]);
  const images = imagesRes.status === 'fulfilled' ? imagesRes.value : [];
  const cloud = cloudRes.status === 'fulfilled' ? cloudRes.value : [];
  const dbDown = imagesRes.status === 'rejected' || cloudRes.status === 'rejected';

  // Fresh haiku per render. `dynamic = 'force-dynamic'` above guarantees this
  // re-evaluates on every request, so the tagline rotates with each page load.
  const haiku = pickOne([...HAIKUS]) ?? HAIKUS[0];

  return (
    <div className="pt-8">
      <section className="mx-auto max-w-2xl space-y-3">
        <h1 className="whitespace-pre-line font-fungal-lite text-3xl leading-snug text-ink-100">
          {haiku.join('\n')}
        </h1>
        <p className="font-mono text-xs text-ink-500">
          {dbDown
            ? 'database not configured -- showing shell only'
            : `${images.length} ${images.length === 1 ? 'picture' : 'pictures'}${activeTags.length > 0 ? ` filtered by: ${activeTags.join(', ')}` : ''}`}
        </p>
      </section>

      <div className="mx-auto mt-8 max-w-2xl">
        <SortBar ownerDefaults={defaults} />
      </div>

      {/* Images centered in their own column; the tag cloud floats on the
          right at lg+ and stacks below the header at smaller widths. */}
      <div className="mt-6 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <ImageGrid images={images} />
        <aside className="order-first lg:order-none lg:sticky lg:top-20 lg:self-start">
          <TagCloud tags={cloud} activeTags={activeTags} />
        </aside>
      </div>

      <div className="grid-floor" aria-hidden="true" />
      {images.length > 0 ? <JsonLd data={buildCollectionPageLd(images)} /> : null}
    </div>
  );
}
