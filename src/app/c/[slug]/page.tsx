import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { ImageGrid } from '@/components/image-grid';
import { ShelfHeader } from '@/components/shelf-header';
import {
  getCollectionBySlug,
  getCollectionWithItems
} from '@/lib/db/queries/collections';
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

  // Owner gating in two halves:
  //   - Signed-in user.id matches the stored ownerHash -> render
  //     edit affordances at SSR time (canEditFromServer=true).
  //   - Anonymous: server can't see the localStorage fingerprint,
  //     so we render canEditFromServer=false. The client component
  //     hydrates and reveals the rename pencil if pix_shelf_slug
  //     matches; the PATCH endpoint still validates the fingerprint
  //     so showing the affordance never grants the action.
  // We only need the raw collection (with ownerHash) for the auth
  // hint, not the full hydrated payload that the page renders.
  const raw = await getCollectionBySlug(params.slug);
  const session = await auth();
  let canEditFromServer = false;
  if (session?.user?.id && raw?.ownerHash === session.user.id) {
    canEditFromServer = true;
  } else if (raw && !session?.user?.id) {
    // Belt-and-suspenders: even for anonymous, if the request IP hash
    // matches AND the stored row has no fingerprint (legacy / pre-
    // fingerprint shelves), treat as owner. Reads the request IP from
    // headers() since this is a server component.
    const reqHeaders = headers();
    const ip =
      reqHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      reqHeaders.get('x-real-ip') ??
      'unknown';
    if (raw.ownerHash === hashIp(ip) && !raw.fingerprint) {
      canEditFromServer = true;
    }
  }

  const title = collection.title?.trim() || 'shelf';
  const count = collection.items.length;

  return (
    <div className="pt-8">
      <ShelfHeader
        slug={collection.slug}
        initialTitle={title}
        canEditFromServer={canEditFromServer}
        count={count}
      />
      <div className="mt-8">
        <ImageGrid images={collection.items} />
      </div>
    </div>
  );
}
