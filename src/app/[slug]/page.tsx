import Image from 'next/image';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { auth, isOwner } from '@/lib/auth';
import { getImageBySlug, getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';
import { getNeighborsByImageId } from '@/lib/db/queries/embeddings';
import { lookupRedirect } from '@/lib/db/queries/slugs';
import { pickOne } from '@/lib/random';
import { ImageActions } from '@/components/image-actions';
import { ImageGrid } from '@/components/image-grid';
import { ExifFacts, PaletteStrip } from '@/components/image-meta';

export const dynamic = 'force-dynamic';

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

  // Fail soft: if the neighbor query throws (missing table, embedding extension
  // trouble, etc.) the detail page still renders. Empty array means either no
  // embeddings exist for this image yet, or there's nothing similar.
  let neighbors: Awaited<ReturnType<typeof hydrateImages>> = [];
  try {
    const matches = await getNeighborsByImageId(img.id, { limit: 6, kind: 'caption' });
    if (matches.length > 0) {
      const rows = await getImagesByIdsOrdered(matches.map((m) => m.imageId));
      neighbors = await hydrateImages(rows);
    }
  } catch (err) {
    console.error('neighbor lookup failed for image', img.id, err);
  }

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

        {owner ? <ImageActions slug={img.slug} /> : null}
      </div>

      {neighbors.length > 0 ? (
        <section aria-label="more like this" className="mx-auto max-w-6xl space-y-4 pt-6">
          <h2 className="font-mono text-xs uppercase tracking-wide text-ink-500">more like this</h2>
          <ImageGrid images={neighbors} />
        </section>
      ) : null}

      <div className="mx-auto max-w-2xl space-y-6">
        <section
          aria-label="reactions"
          className="border-t border-ink-800 pt-4 text-center font-mono text-xs text-ink-600"
        >
          reactions -- coming in phase 3
        </section>
        <section
          aria-label="comments"
          className="border-t border-ink-800 pt-4 text-center font-mono text-xs text-ink-600"
        >
          comments -- coming in phase 3
        </section>
      </div>
    </article>
  );
}
