import type { Metadata } from 'next';
import { listImages, getOwnerHandlesForImages, countImages } from '@/lib/db/queries/images';
import { tagCloud } from '@/lib/db/queries/tags';
import { getGalleryDefaults } from '@/lib/db/queries/gallery-config';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { readNsfwMode } from '@/lib/nsfw';
import { HAIKUS } from '@/lib/haikus';
import { pickOne } from '@/lib/random';
import { InfiniteImageGrid } from '@/components/infinite-image-grid';
import { TagCloud } from '@/components/tag-cloud';
import { TagCloudPanel } from '@/components/tag-cloud-panel';
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

  const nsfwMode = await readNsfwMode();

  // Fail soft: if Postgres isn't reachable, still render the shell with empty
  // data rather than crashing the whole page. Makes local dev less painful
  // and avoids a full-page error if the DB hiccups in prod.
  //
  // Pagination split: `images` (16 rows) is what we paint into the DOM up
  // front for infinite scroll; `seoImages` (30 rows, COLLECTION_ITEM_CAP)
  // feeds CollectionPage JSON-LD so cutting the visible window doesn't
  // shrink the structured-data signal. `totalCount` powers the human-
  // readable header total -- previously this was just `images.length`,
  // which was already capped at the visible window and silently lied.
  const [imagesRes, seoImagesRes, totalRes, cloudRes] = await Promise.allSettled([
    listImages({
      limit: 16,
      tags: activeTags,
      sort: effectiveSort,
      seed: searchParams.seed,
      nsfwMode
    }),
    listImages({
      limit: 30,
      tags: activeTags,
      sort: effectiveSort,
      seed: searchParams.seed,
      nsfwMode
    }),
    countImages(activeTags, { nsfwMode }),
    tagCloud(64)
  ]);
  const images = imagesRes.status === 'fulfilled' ? imagesRes.value : [];
  const seoImages = seoImagesRes.status === 'fulfilled' ? seoImagesRes.value : images;
  const totalCount =
    totalRes.status === 'fulfilled' ? totalRes.value : images.length;
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
        {/* Tiny attribution that re-frames the haiku as a tagline rather than
            a caption-of-the-image-below, so the visual relationship between
            the headline and the first picture in the stream is intentional
            (independent) instead of accidental (decoupled). */}
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-700">
          / a pix.fish haiku /
        </p>
        <p className="font-mono text-xs text-ink-500">
          {dbDown
            ? 'database not configured -- showing shell only'
            : `${totalCount} ${totalCount === 1 ? 'picture' : 'pictures'}${activeTags.length > 0 ? ` filtered by: ${activeTags.join(', ')}` : ''}`}
        </p>
      </section>

      <div className="mx-auto mt-8 max-w-2xl">
        <SortBar ownerDefaults={defaults} />
      </div>

      {/* Images centered in their own column; the tag cloud floats on the
          right at lg+ and stacks below the header at smaller widths. */}
      <div className="mt-6 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <InfiniteImageGrid
          initial={images}
          endpoint="/api/images"
          query={{
            sort: effectiveSort,
            seed: searchParams.seed ?? '',
            tag: activeTags
          }}
        />
        {cloud.length > 0 ? (
          <aside className="order-first lg:order-none lg:sticky lg:top-[calc(5rem_+_var(--pisci-banner-h,0px))] lg:self-start">
            <TagCloudPanel count={cloud.length}>
              <TagCloud tags={cloud} activeTags={activeTags} />
            </TagCloudPanel>
          </aside>
        ) : null}
      </div>

      <div className="grid-floor" aria-hidden="true" />
      {seoImages.length > 0 ? <CollectionLd images={seoImages} /> : null}
    </div>
  );
}

// Server component that resolves owner handles for the visible image set
// in one round-trip and feeds them into the CollectionPage JSON-LD so list
// items emit canonical /u/<handle>/<slug> URLs. Pre-backfill rows fall
// back to /<slug> automatically.
async function CollectionLd({
  images
}: {
  images: Awaited<ReturnType<typeof listImages>>;
}) {
  const handlesByImageId = await getOwnerHandlesForImages(images.map((i) => i.id)).catch(
    () => new Map<number, string>()
  );
  return <JsonLd data={buildCollectionPageLd(images, handlesByImageId)} />;
}
