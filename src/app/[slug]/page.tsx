import Image from 'next/image';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { auth, isOwner } from '@/lib/auth';
import { getImageBySlug, getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';
import { getNeighborsByImageId } from '@/lib/db/queries/embeddings';
import { lookupRedirect } from '@/lib/db/queries/slugs';
import { countReactions } from '@/lib/db/queries/reactions';
import { listApprovedComments } from '@/lib/db/queries/comments';
import { pickOne } from '@/lib/random';
import { ImageActions } from '@/components/image-actions';
import { ExifFacts, PaletteStrip } from '@/components/image-meta';
import type { ImageWithRelations } from '@/lib/db/queries/images';
import { ReactionBar } from '@/components/reaction-bar';
import { CommentList } from '@/components/comment-list';
import { ReportButton } from '@/components/report-button';

export const dynamic = 'force-dynamic';

// Compact 2-column square-crop thumbs for "more like / unlike this". Uses
// object-cover because the 1:1 crop is intentional -- these are navigation
// affordances, not the primary display of the image.
function NeighborGrid({ images }: { images: ImageWithRelations[] }) {
  return (
    <div className="mx-auto grid w-full max-w-md grid-cols-2 gap-2">
      {images.map((img) => (
        <Link
          key={img.id}
          href={`/${img.slug}`}
          className="group relative block aspect-square overflow-hidden rounded border border-ink-800/60 bg-ink-900/30"
        >
          <Image
            src={img.blobUrl}
            alt={img.captions[0]?.text ?? img.slug}
            fill
            sizes="(min-width: 640px) 208px, 45vw"
            className="object-cover transition-transform duration-200 group-hover:scale-[1.03]"
          />
        </Link>
      ))}
    </div>
  );
}

export default async function ImageDetailPage({ params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);

  const img = await getImageBySlug(slug);
  if (!img) {
    const to = await lookupRedirect(slug);
    if (to) permanentRedirect(`/${to}`);
    notFound();
  }

  const session = await auth();
  const owner = isOwner(session);

  // Fail soft: if either neighbor query throws (missing table, embedding
  // extension trouble, etc.) the detail page still renders.
  let neighbors: Awaited<ReturnType<typeof hydrateImages>> = [];
  let opposites: Awaited<ReturnType<typeof hydrateImages>> = [];
  try {
    const [near, far] = await Promise.all([
      getNeighborsByImageId(img.id, { limit: 6, kind: 'caption', order: 'nearest' }),
      getNeighborsByImageId(img.id, { limit: 6, kind: 'caption', order: 'farthest' })
    ]);
    if (near.length > 0) {
      const rows = await getImagesByIdsOrdered(near.map((m) => m.imageId));
      neighbors = await hydrateImages(rows);
    }
    if (far.length > 0) {
      const rows = await getImagesByIdsOrdered(far.map((m) => m.imageId));
      opposites = await hydrateImages(rows);
    }
  } catch (err) {
    console.error('neighbor lookup failed for image', img.id, err);
  }

  // Fail soft on engagement data -- page still works without it
  const [reactionCounts, approvedComments] = await Promise.all([
    countReactions(img.id).catch(() => ({ up: 0, down: 0 })),
    listApprovedComments(img.id).catch(() => [])
  ]);

  const caption = pickOne(img.captions)?.text ?? '';
  const description = pickOne(img.descriptions)?.text ?? '';
  const uploaded = new Date(img.uploadedAt).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  return (
    <article className="space-y-8 pt-6">
      <div className="relative mx-auto max-w-4xl">
        {img.width && img.height ? (
          <Image
            src={img.blobUrl}
            alt={caption || img.slug}
            width={img.width}
            height={img.height}
            className="h-auto w-full rounded-lg border border-ink-800"
            priority
          />
        ) : (
          <img
            src={img.blobUrl}
            alt={caption || img.slug}
            className="h-auto w-full rounded-lg border border-ink-800"
          />
        )}
      </div>

      <div className="mx-auto max-w-2xl space-y-6">
        {caption ? (
          <h1 className="prose-caption text-center text-2xl leading-snug text-ink-100 sm:text-3xl">
            {caption}
          </h1>
        ) : null}
        {description ? (
          <p className="prose-caption mx-auto max-w-prose text-center text-base text-ink-300">
            {description}
          </p>
        ) : null}

        {img.tags.length > 0 ? (
          <div className="flex flex-wrap justify-center gap-1.5 pt-2">
            {img.tags.map((t) => (
              <Link key={t.id} href={`/?tag=${encodeURIComponent(t.tag)}`} className="chip">
                {t.tag}
              </Link>
            ))}
          </div>
        ) : null}

        <p className="text-center font-mono text-xs text-ink-500">{uploaded}</p>

        <PaletteStrip colors={img.palette} />
        <ExifFacts exif={img.exif as Record<string, unknown> | null} />

        <ReactionBar slug={img.slug} initialCounts={reactionCounts} />

        {owner ? <ImageActions slug={img.slug} /> : null}

        <div className="flex justify-end pt-1">
          <ReportButton targetType="image" targetId={img.id} />
        </div>
      </div>

      {neighbors.length > 0 ? (
        <section aria-label="more like this" className="mx-auto max-w-md space-y-3 pt-6">
          <h2 className="text-center font-mono text-xs uppercase tracking-wide text-ink-500">more like this</h2>
          <NeighborGrid images={neighbors} />
        </section>
      ) : null}

      {opposites.length > 0 ? (
        <section aria-label="more unlike this" className="mx-auto max-w-md space-y-3 pt-6">
          <h2 className="text-center font-mono text-xs uppercase tracking-wide text-ink-500">more unlike this</h2>
          <NeighborGrid images={opposites} />
        </section>
      ) : null}

      <div className="mx-auto max-w-2xl pb-8">
        <CommentList slug={img.slug} comments={approvedComments} />
      </div>
    </article>
  );
}
