import { getImageBySlug } from '@/lib/db/queries/images';
import { pickSlugCaption } from '@/lib/seo/image-meta';
import { renderOgCard, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/seo/og-card';

// Same card for the legacy bare-slug route. Links shared before the multi-user
// migration still circulate, so they get a proper card too rather than falling
// back to the raw blob.
export const runtime = 'nodejs';
export const alt = 'pix.fish';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function OgImage({ params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const img = await getImageBySlug(slug).catch(() => null);
  if (!img) return renderOgCard({ imageUrl: '', caption: 'not found' });

  return renderOgCard({ imageUrl: img.blobUrl, caption: pickSlugCaption(img) });
}
