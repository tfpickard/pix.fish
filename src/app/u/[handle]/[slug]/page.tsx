import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getImageByHandleAndSlug } from '@/lib/db/queries/images';
import { getUserById } from '@/lib/db/queries/users';
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
  // Handles are stored lower-case (resolveHandle slugifies + lower-cases on
  // sign-in); normalize the URL segment so /u/Foo resolves to the same row
  // as /u/foo. URL slugs stay verbatim -- they're already lower-case at
  // creation but a canonical URL might link with mixed-case via slug_history.
  const handle = decodeURIComponent(params.handle).toLowerCase();
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
  const handle = decodeURIComponent(params.handle).toLowerCase();
  const slug = decodeURIComponent(params.slug);
  const img = await getImageByHandleAndSlug(handle, slug);
  if (!img) notFound();
  // displayName is best-effort -- a missing/legacy users row falls through
  // to handle as the JSON-LD creator name.
  const owner = await getUserById(img.ownerId).catch(() => null);
  return (
    <ImageDetail
      img={img}
      ownerHandle={handle}
      ownerName={owner?.displayName ?? null}
    />
  );
}
