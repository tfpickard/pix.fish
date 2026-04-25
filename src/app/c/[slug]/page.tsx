import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { ImageGrid } from '@/components/image-grid';
import { ShelfHeader } from '@/components/shelf-header';
import { getCollectionWithItems } from '@/lib/db/queries/collections';
import { hashIp } from '@/lib/hash';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Shelves are private-by-share-link: the URL itself is the access
// credential. We don't want them in search indexes (they'd duplicate
// gallery content under a different URL and would also leak whatever
// taste the visitor expressed by saving). robots: noindex.
export async function generateMetadata({
  params
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const collection = await getCollectionWithItems(params.slug).catch(() => null);
  return {
    title: collection?.title ?? 'shelf',
    description: collection
      ? `${collection.items.length} pictures saved on this shelf.`
      : 'a saved shelf on pix.fish.',
    alternates: { canonical: `/c/${params.slug}` },
    robots: { index: false, follow: false }
  };
}

export default async function ShelfPage({ params }: { params: { slug: string } }) {
  const collection = await getCollectionWithItems(params.slug);
  if (!collection) notFound();

  // The viewer is the owner if their request hash matches the stored
  // ownerHash. Edit affordances render only for them. Next 14 returns
  // headers() synchronously; the type isn't a Promise so no await.
  const reqHeaders = headers();
  const ip =
    reqHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    reqHeaders.get('x-real-ip') ??
    'unknown';
  const session = await auth();
  const requesterHash = session?.user?.id ?? hashIp(ip);
  const isOwner = requesterHash === collection.ownerHash;

  const title = collection.title?.trim() || 'shelf';
  const count = collection.items.length;

  return (
    <div className="pt-8">
      <ShelfHeader
        slug={collection.slug}
        initialTitle={title}
        canEdit={isOwner}
        count={count}
      />
      <div className="mt-8">
        <ImageGrid images={collection.items} />
      </div>
    </div>
  );
}
