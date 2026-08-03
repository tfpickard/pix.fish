import { getImageByHandleAndSlug } from '@/lib/db/queries/images';
import { pickSlugCaption } from '@/lib/seo/image-meta';
import { renderOgCard, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/seo/og-card';

// File-based OG image for the canonical detail route. Next wires this into
// og:image / twitter:image automatically (with the correct declared dimensions),
// which is why buildImageDetailMetadata no longer sets openGraph.images itself.
export const runtime = 'nodejs';
// Pinning what is currently implicit, not fixing an observed bug: this route
// already builds as dynamic (verified -- it reports as such with and without
// this line), because the segment has dynamic params and no
// generateStaticParams. The sibling page.tsx being force-dynamic does NOT
// reach here; route segment config is per-file.
//
// It is worth stating anyway. If this route ever landed in Next's Full Route
// Cache, the first card rendered per slug would freeze there and every
// Cache-Control decision in og-card.tsx would become decoration -- including
// the short TTL that exists so a card rendered during a blob outage cannot
// outlive it. A Drizzle read is invisible to that machinery (only fetch and
// the dynamic APIs are instrumented), so nothing else here would prevent it.
//
// force-dynamic rather than a revalidate value: the response already carries
// the right policy for its own case (full for a real card, 60s for a degraded
// one), and one route-level window cannot express both. The edge still absorbs
// the cost via s-maxage, so this does not mean rendering per request.
export const dynamic = 'force-dynamic';
export const alt = 'pix.fish';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function OgImage({
  params
}: {
  params: { handle: string; slug: string };
}) {
  // Mirror the page's own normalization: handles are stored lower-case, slugs
  // verbatim. A mismatch here would silently produce a blank card.
  const handle = decodeURIComponent(params.handle).toLowerCase();
  const slug = decodeURIComponent(params.slug);

  const img = await getImageByHandleAndSlug(handle, slug).catch(() => null);
  if (!img) return renderOgCard({ imageUrl: '', caption: 'not found' });

  return renderOgCard({ imageUrl: img.blobUrl, caption: pickSlugCaption(img) });
}
