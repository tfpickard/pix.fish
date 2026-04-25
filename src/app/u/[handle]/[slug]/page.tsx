import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getImageByHandleAndSlug } from '@/lib/db/queries/images';
import { ImageDetail, buildImageDetailMetadata } from '@/components/image-detail';

export const dynamic = 'force-dynamic';

// Phase D canonical image detail at /u/<handle>/<slug>. Slugs are unique
// per (owner, slug) so this single join lookup is unambiguous; legacy
// /<slug> still renders for back-compat but its canonical metadata points
// here.
export async function generateMetadata({
  params
}: {
  params: { handle: string; slug: string };
}): Promise<Metadata> {
  const handle = decodeURIComponent(params.handle);
  const slug = decodeURIComponent(params.slug);
  const img = await getImageByHandleAndSlug(handle, slug).catch((err) => {
    console.error('/u/[handle]/[slug]: lookup failed', handle, slug, err);
    return null;
  });
  if (!img) return { title: 'not found', robots: { index: false, follow: false } };
  return buildImageDetailMetadata(img, handle);
}

export default async function HandleImageDetailPage({
  params
}: {
  params: { handle: string; slug: string };
}) {
  const handle = decodeURIComponent(params.handle);
  const slug = decodeURIComponent(params.slug);
  const img = await getImageByHandleAndSlug(handle, slug);
  if (!img) notFound();
  return <ImageDetail img={img} />;
}
