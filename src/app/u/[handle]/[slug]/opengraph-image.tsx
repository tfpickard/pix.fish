import { getImageByHandleAndSlug } from '@/lib/db/queries/images';
import { pickSlugCaption } from '@/lib/seo/image-meta';
import { renderOgCard, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/seo/og-card';

// File-based OG image for the canonical detail route. Next wires this into
// og:image / twitter:image automatically (with the correct declared dimensions),
// which is why buildImageDetailMetadata no longer sets openGraph.images itself.
export const runtime = 'nodejs';
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
