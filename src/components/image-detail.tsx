import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { auth, canEdit } from '@/lib/auth';
import { getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';
import { getCaptionVector, getNeighborsByImageId } from '@/lib/db/queries/embeddings';
import { countReactions } from '@/lib/db/queries/reactions';
import { listApprovedComments } from '@/lib/db/queries/comments';
import { pickOne } from '@/lib/random';
import { ImageActions } from '@/components/image-actions';
import { EmbeddingViz } from '@/components/embedding-viz';
import { ExifFacts, PaletteEdgeBand } from '@/components/image-meta';
import type { ImageWithRelations } from '@/lib/db/queries/images';
import { getImageProvenance } from '@/lib/db/queries/provenance';
import { ProvenancePanel } from '@/components/provenance-panel';
import { ReactionBar } from '@/components/reaction-bar';
import { SaveToShelf } from '@/components/save-to-shelf';
import { CommentList } from '@/components/comment-list';
import { ReportButton } from '@/components/report-button';
import { JsonLd } from '@/components/json-ld';
import { buildImageObjectLd } from '@/lib/seo/jsonld';
import {
  buildImageTitle,
  buildImageDescription,
  buildImageKeywords,
  pickSlugCaption
} from '@/lib/seo/image-meta';
import { absoluteUrl } from '@/lib/site';

// Canonical URL for an image. Phase D moves the canonical from /<slug> to
// /u/<handle>/<slug> so search engines pick up the per-user namespace; the
// legacy /<slug> path keeps rendering and just points its canonical link
// here. When the owner's handle isn't resolvable, fall back to the legacy
// shape so we never emit a broken canonical.
export function canonicalImagePath(img: { slug: string }, ownerHandle: string | null): string {
  if (ownerHandle) return `/u/${ownerHandle}/${img.slug}`;
  return `/${img.slug}`;
}

export function buildImageDetailMetadata(
  img: ImageWithRelations,
  ownerHandle: string | null
): Metadata {
  const title = buildImageTitle(img);
  const description = buildImageDescription(img);
  const keywords = buildImageKeywords(img);
  const canonical = canonicalImagePath(img, ownerHandle);
  const caption = pickSlugCaption(img);

  const ogImage = {
    url: img.blobUrl,
    width: img.width ?? 1200,
    height: img.height ?? 630,
    alt: caption
  };

  return {
    title,
    description,
    keywords,
    alternates: { canonical },
    openGraph: {
      type: 'article',
      url: absoluteUrl(canonical),
      title,
      description,
      images: [ogImage],
      publishedTime: (img.takenAt ?? img.uploadedAt).toISOString(),
      modifiedTime: img.uploadedAt.toISOString(),
      tags: img.tags.map((t) => t.tag)
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [img.blobUrl]
    }
  };
}

// Compact 2-column thumb grid for "more like / unlike this". Square crops
// because these are navigation affordances, not the primary display. Links
// route through legacy /<slug>; the destination page emits a canonical
// link to /u/<handle>/<slug> via metadata, so search engines still pick
// up the canonical URL. A future polish would hydrate owner handles for
// neighbors and emit /u/<handle>/<slug> links directly.
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

export async function ImageDetail({
  img,
  ownerHandle,
  ownerName
}: {
  img: ImageWithRelations;
  ownerHandle?: string | null;
  ownerName?: string | null;
}) {
  const session = await auth();
  const owner = canEdit(session, img.ownerId);

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

  const [reactionCounts, approvedComments, captionVector, provenance] = await Promise.all([
    countReactions(img.id).catch(() => ({ up: 0, down: 0 })),
    listApprovedComments(img.id).catch(() => []),
    getCaptionVector(img.id).catch(() => null),
    getImageProvenance(img.id).catch(() => [])
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
      <JsonLd
        data={buildImageObjectLd(img, {
          comments: approvedComments,
          ownerHandle,
          ownerName
        })}
      />
      <div className="relative mx-auto max-w-4xl">
        {/* width/height are unknown for most rows -- the upload pipeline
            doesn't probe dimensions (per CLAUDE.md: "image-meta.ts does not
            probe dimensions"). Use next/image's `width=0 height=0` + `sizes`
            pattern: it routes through the optimizer (so the URL is fetched
            server-side and re-served same-origin, sidestepping any
            client-side cross-origin gotchas) and lets CSS size the rendered
            element to the image's natural aspect once it loads. When
            dimensions ARE known, pass them so layout stabilizes faster. */}
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
          <Image
            src={img.blobUrl}
            alt={caption || img.slug}
            width={0}
            height={0}
            sizes="(min-width: 1024px) 1024px, 100vw"
            className="h-auto w-full rounded-lg border border-ink-800"
            priority
          />
        )}
        <PaletteEdgeBand colors={img.palette} />
      </div>

      {captionVector ? <EmbeddingViz vector={captionVector} /> : null}

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

        <ExifFacts exif={img.exif as Record<string, unknown> | null} />

        <ReactionBar slug={img.slug} initialCounts={reactionCounts} />

        <SaveToShelf imageId={img.id} />

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

      <ProvenancePanel entries={provenance} />
    </article>
  );
}
