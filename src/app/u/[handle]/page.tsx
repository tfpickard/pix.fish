import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { listImagesByHandle } from '@/lib/db/queries/images';
import { ImageGrid } from '@/components/image-grid';
import { SITE_NAME } from '@/lib/site';
import { readShowNsfwCookie } from '@/lib/nsfw';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params
}: {
  params: { handle: string };
}): Promise<Metadata> {
  const handle = decodeURIComponent(params.handle);
  return {
    title: `${handle} -- ${SITE_NAME}`,
    description: `Photographs uploaded by ${handle} on ${SITE_NAME}.`,
    alternates: { canonical: `/u/${handle}` }
  };
}

// Per-user gallery. Newest-first listing of one owner's images, no sort
// modes -- the public stream at / is where embedding-driven reorder
// modes live. NSFW filtering follows the visitor's site-wide preference
// (phase E plumbs the toggle through; for now this matches whatever
// /api/images returns).
export default async function HandleGalleryPage({
  params
}: {
  params: { handle: string };
}) {
  const handle = decodeURIComponent(params.handle);
  const includeNsfw = await readShowNsfwCookie();
  const { owner, images } = await listImagesByHandle(handle, { limit: 60, includeNsfw });
  if (!owner) notFound();
  return (
    <div className="pt-8">
      <header className="mx-auto max-w-2xl space-y-2">
        <h1 className="font-fungal-lite text-3xl text-ink-100">
          {owner.displayName ?? owner.handle}
        </h1>
        <p className="font-mono text-xs text-ink-500">
          /u/{owner.handle} -- {images.length} {images.length === 1 ? 'picture' : 'pictures'}
        </p>
      </header>
      <div className="mx-auto mt-8 max-w-4xl">
        <ImageGrid images={images} />
      </div>
    </div>
  );
}
