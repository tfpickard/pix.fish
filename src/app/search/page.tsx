import type { Metadata } from 'next';
import Link from 'next/link';
import { getEmbedder, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { searchByVector, searchLoreByVector } from '@/lib/db/queries/embeddings';
import {
  DEFAULT_SEARCH_SIM_THRESHOLD,
  getGalleryDefaults
} from '@/lib/db/queries/gallery-config';
import { getImagesByIdsOrdered, hydrateImages, imageRefsByIds } from '@/lib/db/queries/images';
import { getLoreFragmentBodies } from '@/lib/db/queries/lore-fragments';
import { tagCloud } from '@/lib/db/queries/tags';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { readNsfwMode } from '@/lib/nsfw';
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
  searchParams: Promise<{ q?: string }>;
};

export default async function SearchPage({ searchParams }: PageProps) {
  const { q: rawQ } = await searchParams;
  const q = (rawQ ?? '').trim();

  if (!q) {
    // Cold start: a blank box gives a first-timer nothing to grab onto and no
    // hint that this search reads meaning, not keywords. Surface live popular
    // tags as one-click semantic queries so the page demonstrates itself.
    // Best-effort -- a DB hiccup just falls back to the bare prompt.
    let suggestions: string[] = [];
    try {
      // Scope suggestions to the visitor's NSFW mode -- the same gate the
      // search they launch uses -- so a tag that lives only on NSFW images
      // can't leak its label or send an opted-out visitor to an empty search.
      const nsfwMode = await readNsfwMode();
      suggestions = (await tagCloud(14, nsfwMode)).map((t) => t.tag);
    } catch {
      suggestions = [];
    }
    return (
      <div className="space-y-6 pt-8">
        <h1 className="font-fungal-lite text-3xl text-ink-100">search</h1>
        <p className="font-mono text-xs text-ink-500">enter a query above to search semantically.</p>
        {suggestions.length > 0 ? (
          <div className="space-y-2">
            <p className="font-mono text-xs text-ink-500">or start from one of these:</p>
            <div className="flex flex-wrap gap-1">
              {suggestions.map((tag) => (
                // prefetch={false}: each target is a force-dynamic semantic
                // search (an embedding API call + a vector query). Letting Next
                // prefetch all 14 on viewport entry would fire that work -- and
                // burn AI quota -- for results nobody asked for.
                <Link
                  key={tag}
                  href={`/search?q=${encodeURIComponent(tag)}`}
                  prefetch={false}
                  className="chip"
                >
                  {tag}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
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
  let rankedCount = 0;
  let failed = false;
  // Lore matches: images whose clerk-authored dossier (not just its caption)
  // is close to the query. Shown in their own section so the archive's writing
  // is searchable alongside the pictures.
  type LoreResult = { imageId: number; slug: string; handle: string | null; excerpt: string };
  let loreResults: LoreResult[] = [];
  try {
    const [cfg, adminKeys, nsfwMode] = await Promise.all([
      loadAiConfig(),
      loadUserProviderKeys(getSiteAdminId()),
      readNsfwMode()
    ]);
    const embedder = getEmbedder(cfg, adminKeys);
    if (!embedder) throw new Error('embedder unavailable');
    const vec = await embedder.embed(q);
    const matches = await searchByVector(vec, { limit: 60, kind: 'caption', nsfwMode });
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
    hydrated = await hydrateImages(rows);
    similarities = new Map(ranked.map((m) => [m.imageId, m.similarity]));

    // Same query vector, ranked against the lore corpus. Apply the same
    // closeness threshold, drop anything already shown as an image match, and
    // gate by the same NSFW/archived visibility rules as the rest of the site.
    const loreMatches = await searchLoreByVector(vec, { limit: 24 });
    const loreRanked = loreMatches
      .map((m) => ({ ...m, similarity: Math.max(0, Math.min(1, 1 - m.distance)) }))
      .filter((m) => m.similarity >= simThreshold);
    if (loreRanked.length > 0) {
      const shownImageIds = new Set(hydrated.map((h) => h.id));
      const [refs, bodies] = await Promise.all([
        imageRefsByIds([...new Set(loreRanked.map((m) => m.specimenImageId))]),
        getLoreFragmentBodies([...new Set(loreRanked.map((m) => m.loreFragmentId))])
      ]);
      const seen = new Set<number>();
      for (const m of loreRanked) {
        if (shownImageIds.has(m.specimenImageId) || seen.has(m.specimenImageId)) continue;
        const ref = refs.get(m.specimenImageId);
        if (!ref || ref.archived) continue;
        if (nsfwMode === 'hide' && ref.isNsfw) continue;
        if (nsfwMode === 'only' && !ref.isNsfw) continue;
        seen.add(m.specimenImageId);
        const body = (bodies.get(m.loreFragmentId) ?? '').trim().replace(/\s+/g, ' ');
        loreResults.push({
          imageId: m.specimenImageId,
          slug: ref.slug,
          handle: ref.handle,
          excerpt: body.length > 220 ? `${body.slice(0, 219)}…` : body
        });
      }
    }
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

      {!failed && loreResults.length > 0 ? (
        <section className="space-y-3 border-t border-ink-800 pt-6">
          <h2 className="font-mono text-xs uppercase tracking-wide text-ink-500">
            from the dossiers
          </h2>
          <ul className="space-y-3">
            {loreResults.map((r) => (
              <li key={r.imageId} className="space-y-1 border-b border-ink-800/60 pb-3">
                <Link
                  href={r.handle ? `/u/${r.handle}/${r.slug}` : `/${r.slug}`}
                  prefetch={false}
                  className="font-mono text-xs text-ink-300 underline-offset-2 hover:text-ink-100 hover:underline"
                >
                  {r.slug}
                </Link>
                <p className="prose-caption text-sm leading-relaxed text-ink-300">{r.excerpt}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
