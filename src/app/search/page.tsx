import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
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
import { BASEMENT_COOKIE, BASEMENT_PASSPHRASE, readBasementCookie } from '@/lib/basement';

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

  // Passphrase unlock ritual: exact match (case-insensitive) against the
  // basement passphrase. Sets the cookie server-side and redirects to
  // /basement so the URL bar shows the destination without exposing the
  // passphrase as a query param in the browser history.
  if (q.toLowerCase() === BASEMENT_PASSPHRASE.toLowerCase()) {
    const store = await cookies();
    store.set(BASEMENT_COOKIE, 'unlocked', {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7
    });
    redirect('/basement');
  }

  // Basement gate: exclude basement images from search results for locked
  // visitors. The embedding lookup returns imageIds without visibility
  // filtering, so we filter post-hydration rather than modifying searchByVector.
  const basementUnlocked = await readBasementCookie();

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
  let rankedCount = 0;
  let failed = false;
  try {
    const cfg = await loadAiConfig();
    const adminKeys = await loadUserProviderKeys(getSiteAdminId());
    const embedder = getEmbedder(cfg, adminKeys);
    if (!embedder) throw new Error('embedder unavailable');
    const vec = await embedder.embed(q);
    const matches = await searchByVector(vec, { limit: 60, kind: 'caption' });
    totalScored = matches.length;
    // Cosine distance is in [0, 2] (0 = identical, 2 = opposite), so the
    // similarity = 1 - distance is in [-1, 1]. Clamp to [0, 1] for both
    // the threshold compare and the per-card percentage badge so neither
    // can show negative or above-100% values.
    const ranked = matches
      .map((m) => ({
        imageId: m.imageId,
        similarity: Math.max(0, Math.min(1, 1 - m.distance))
      }))
      .filter((m) => m.similarity >= simThreshold);
    rankedCount = ranked.length;
    const rows = await getImagesByIdsOrdered(ranked.map((m) => m.imageId));
    const allHydrated = await hydrateImages(rows);
    // Strip basement images from results when the visitor hasn't unlocked.
    // This is a secondary gate -- the primary is at the query layer for
    // listImages; here we intercept the embedding-path which doesn't pass
    // through that layer.
    hydrated = basementUnlocked ? allHydrated : allHydrated.filter((img) => !img.basement);
    similarities = new Map(ranked.map((m) => [m.imageId, m.similarity]));
  } catch (err) {
    console.error('semantic search failed', err);
    failed = true;
  }

  // "too far to bother" counts only matches dropped by the threshold,
  // not rows that were missing during hydration (deletes, etc).
  const trimmed = totalScored - rankedCount;

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
