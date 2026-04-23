import { listImages } from '@/lib/db/queries/images';
import { tagCloud } from '@/lib/db/queries/tags';
import { HAIKUS } from '@/lib/haikus';
import { pickOne } from '@/lib/random';
import { ImageGrid } from '@/components/image-grid';
import { TagCloud } from '@/components/tag-cloud';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type PageProps = {
  searchParams: { tag?: string | string[] };
};

function normalizeTags(input: string | string[] | undefined): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  return [input];
}

export default async function HomePage({ searchParams }: PageProps) {
  const activeTags = normalizeTags(searchParams.tag);

  // Fail soft: if Postgres isn't reachable, still render the shell with empty
  // data rather than crashing the whole page. Makes local dev less painful
  // and avoids a full-page error if the DB hiccups in prod.
  const [imagesRes, cloudRes] = await Promise.allSettled([
    listImages({ limit: 60, tags: activeTags }),
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
        <h1 className="prose-caption whitespace-pre-line font-display text-3xl leading-snug text-ink-100">
          {haiku.join('\n')}
        </h1>
        <p className="font-mono text-xs text-ink-500">
          {dbDown
            ? 'database not configured -- showing shell only'
            : `${images.length} ${images.length === 1 ? 'picture' : 'pictures'}${activeTags.length > 0 ? ` filtered by: ${activeTags.join(', ')}` : ''}`}
        </p>
      </section>

      {/* Images centered in their own column; the tag cloud floats on the
          right at lg+ and stacks below the header at smaller widths. */}
      <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <ImageGrid images={images} />
        <aside className="order-first lg:order-none lg:sticky lg:top-20 lg:self-start">
          <TagCloud tags={cloud} activeTags={activeTags} />
        </aside>
      </div>

      <div className="grid-floor" aria-hidden="true" />
    </div>
  );
}
