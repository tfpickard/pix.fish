import type { Metadata } from 'next';
import { getEmbedder } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { searchByVector } from '@/lib/db/queries/embeddings';
import { getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';
import { ImageGrid } from '@/components/image-grid';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Don't let the query-param surface pollute the index. The /search shell stays
// discoverable via the sitemap but every materialized result page is thin
// content from Google's perspective -- the underlying images already rank at
// their canonical /[slug] URLs.
export const metadata: Metadata = {
  title: 'search',
  description: 'Semantic search across the pix.fish photography gallery.',
  alternates: { canonical: '/search' },
  robots: { index: false, follow: true }
};

type PageProps = {
  searchParams: { q?: string };
};

export default async function SearchPage({ searchParams }: PageProps) {
  const q = (searchParams.q ?? '').trim();

  if (!q) {
    return (
      <div className="space-y-6 pt-8">
        <h1 className="font-fungal-lite text-3xl text-ink-100">search</h1>
        <p className="font-mono text-xs text-ink-500">enter a query above to search semantically.</p>
      </div>
    );
  }

  // Go straight to the DB query -- skipping the HTTP hop through /api/search
  // saves a round trip and keeps this a single server render.
  let hydrated: Awaited<ReturnType<typeof hydrateImages>> = [];
  let failed = false;
  try {
    const cfg = await loadAiConfig();
    const embedder = getEmbedder(cfg);
    const vec = await embedder.embed(q);
    const matches = await searchByVector(vec, { limit: 60, kind: 'caption' });
    const rows = await getImagesByIdsOrdered(matches.map((m) => m.imageId));
    hydrated = await hydrateImages(rows);
  } catch (err) {
    console.error('semantic search failed', err);
    failed = true;
  }

  return (
    <div className="space-y-6 pt-8">
      <section className="space-y-2">
        <h1 className="font-fungal-lite text-3xl text-ink-100">search</h1>
        <p className="font-mono text-xs text-ink-500">
          {failed
            ? 'search is currently unavailable'
            : `${hydrated.length} match${hydrated.length === 1 ? '' : 'es'} for "${q}"`}
        </p>
      </section>
      {!failed ? <ImageGrid images={hydrated} /> : null}
    </div>
  );
}
