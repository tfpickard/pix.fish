import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getImageBySlug } from '@/lib/db/queries/images';
import { getUserById } from '@/lib/db/queries/users';
import { lookupRedirect } from '@/lib/db/queries/slugs';
import { ImageDetail, buildImageDetailMetadata } from '@/components/image-detail';

export const dynamic = 'force-dynamic';

// Legacy /<slug> route. Slugs are now per-owner unique, so a global slug
// lookup picks the site admin's row first (so original-owner URLs keep
// working) and falls back to the oldest match. Metadata's canonical link
// always points at /u/<handle>/<slug>, the Phase D canonical.
async function resolveLegacy(slug: string) {
  const img = await getImageBySlug(slug).catch((err) => {
    console.error('[slug]: getImageBySlug failed', slug, err);
    return null;
  });
  if (!img) return { img: null as null, ownerHandle: null as null, ownerName: null as null };
  const owner = await getUserById(img.ownerId).catch(() => null);
  return {
    img,
    ownerHandle: owner?.handle ?? null,
    ownerName: owner?.displayName ?? null
  };
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const slug = decodeURIComponent(params.slug);
  const { img, ownerHandle } = await resolveLegacy(slug);
  if (!img) {
    // Slug retired to slug_history -> the page body emits a 308 redirect.
    // Mark the transient response noindex so a bot that ignores the redirect
    // doesn't cache a stale title.
    const to = await lookupRedirect(slug).catch(() => null);
    if (to) return { robots: { index: false, follow: true } };
    return { title: 'not found', robots: { index: false, follow: false } };
  }
  return buildImageDetailMetadata(img, ownerHandle);
}

export default async function ImageDetailPage({ params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const { img, ownerHandle, ownerName } = await resolveLegacy(slug);
  if (!img) {
    const to = await lookupRedirect(slug);
    if (to) permanentRedirect(`/${to.slug}`);
    notFound();
  }
  return <ImageDetail img={img} ownerHandle={ownerHandle} ownerName={ownerName} />;
}
