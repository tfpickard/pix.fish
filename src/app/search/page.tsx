import type { Metadata } from 'next';
import { getEmbedder, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { searchByVector } from '@/lib/db/queries/embeddings';
import {
  DEFAULT_SEARCH_SIM_THRESHOLD,
  getGalleryDefaults
} from '@/lib/db/queries/gallery-config';
import { getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';
import { getSiteAdminId } from '@/lib/db/queries/users';
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

  // Threshold is owner-configurable via /admin/gallery; falls back to the
  // hard-coded constant when the gallery_config row is missing or the
  // table itself isn't migrated yet.
  const ownerDefaults = await getGalleryDefaults(getSiteAdminId()).catch(() => null);
  const simThreshold = ownerDefaults?.searchSimilarityThreshold ?? DEFAULT_SEARCH_SIM_THRESHOLD;

  // Go straight to the DB query -- skipping the HTTP hop through /api/search
  // saves a round trip and keeps this a single server render.
  let hydrated: Awaited<ReturnType<typeof hydrateImages>> = [];
  let similarities = new Map<number, number>();
  let totalScored = 0;
  let failed = false;
  try {
    const cfg = await loadAiConfig();
    const adminKeys = await loadUserProviderKeys(getSiteAdminId());
    const embedder = getEmbedder(cfg, adminKeys);
    if (!embedder) throw new Error('embedder unavailable');
    const vec = await embedder.embed(q);
    const matches = await searchByVector(vec, { limit: 60, kind: 'caption' });
    totalScored = matches.length;
    // Cosine distance -> similarity in [0..1] (clamped). The threshold
    // trims results we'd be embarrassed to call "matches"; a query like
    // "melancholy water" still sees its top hits but stops at the first
    // bottom-of-the-barrel image instead of returning the entire gallery.
    const ranked = matches
      .map((m) => ({ imageId: m.imageId, similarity: 1 - m.distance }))
      .filter((m) => m.similarity >= simThreshold);
    const rows = await getImagesByIdsOrdered(ranked.map((m) => m.imageId));
    hydrated = await hydrateImages(rows);
    similarities = new Map(ranked.map((m) => [m.imageId, m.similarity]));
  } catch (err) {
    console.error('semantic search failed', err);
    failed = true;
  }

  const trimmed = totalScored - hydrated.length;

  return (
    <div className="space-y-6 pt-8">
      <section className="space-y-2">
        <h1 className="font-fungal-lite text-3xl text-ink-100">search</h1>
        <p className="font-mono text-xs text-ink-500">
          {failed
            ? 'search is currently unavailable'
            : hydrated.length === 0
              ? `nothing close enough for "${q}"`
              : `ranked by closeness -- ${hydrated.length} result${hydrated.length === 1 ? '' : 's'} for "${q}"${trimmed > 0 ? ` (+${trimmed} too far to bother)` : ''}`}
        </p>
      </section>
      {!failed ? <ImageGrid images={hydrated} similarities={similarities} /> : null}
    </div>
  );
}
