'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { ImageWithRelations } from '@/lib/db/queries/images';
import { buildSrcSet, largestDerivativeUrl } from '@/lib/images/derivatives';
import { CardEngagement } from './card-engagement';

type Props = {
  image: ImageWithRelations;
  // Optional similarity badge ("87% match"). Used by /search to surface
  // closeness ranking next to each result.
  similarity?: number;
};

export function ImageCard({ image, similarity }: Props) {
  // Deterministic per-image caption pick. The previous Math.random() pick
  // ran at every render in client contexts (e.g. the InfiniteImageGrid
  // re-rendering as `isLoading` toggles), which caused hydration
  // mismatches and visible caption flicker. Keying the choice off
  // image.id keeps the same caption stable across server -> client
  // hydration AND across re-renders, while still surfacing different
  // variants on neighboring cards so the grid doesn't feel monotonous.
  const caption = useMemo(() => {
    if (image.captions.length === 0) return '';
    const idx = ((image.id % image.captions.length) + image.captions.length) % image.captions.length;
    return image.captions[idx]?.text ?? '';
  }, [image.id, image.captions]);
  const tags = image.tags.slice(0, 5);
  const aspect = image.width && image.height ? image.width / image.height : 1;
  // Serve the small precomputed WebP derivatives, never the full-res original.
  // srcSet + sizes let the browser pick the right width for the tile and DPR;
  // when a row has no derivatives yet (legacy / not-yet-processed) we fall back
  // to the original so nothing breaks. Plain <img> on purpose: it bypasses the
  // Next/Vercel image optimizer so we serve the precomputed file directly
  // instead of paying to re-transform the original at request time.
  const srcSet = buildSrcSet(image.derivatives);
  const imgSrc = largestDerivativeUrl(image.derivatives) ?? image.blobUrl;
  const similarityLabel =
    typeof similarity === 'number' && Number.isFinite(similarity)
      ? `${Math.round(Math.max(0, Math.min(1, similarity)) * 100)}%`
      : null;

  return (
    // data-attention-id is the dwell-telemetry hook: InfiniteImageGrid's
    // IntersectionObserver watches [data-attention-id] tiles to measure time on
    // screen and POST /api/attention. Without it the observer matches nothing
    // and no attention is ever recorded (feeding the drift sort and the
    // /attention board). Inert everywhere the observer isn't mounted.
    <div
      data-attention-id={image.id}
      className="neon-card group relative overflow-hidden rounded-md border border-ink-800/80 bg-ink-900/30"
    >
      {similarityLabel ? (
        <span className="absolute right-2 top-2 z-10 rounded-sm border border-primary/40 bg-ink-950/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary">
          {similarityLabel}
        </span>
      ) : null}
      {/* Only the image + caption are wrapped in the link. The engagement
          footer below carries interactive vote buttons, which would otherwise
          trigger navigation if nested inside the anchor. */}
      <Link href={`/${image.slug}`} className="block">
        <div className="relative w-full" style={{ aspectRatio: aspect }}>
          {image.isNsfw ? (
            <span className="absolute left-2 top-2 z-10 rounded-sm border border-rose-700/70 bg-ink-950/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-rose-600">
              nsfw
            </span>
          ) : null}
          {/* object-contain preserves the original aspect so a portrait and a
              landscape both show uncropped. Below-the-fold tiles load lazily. */}
          <img
            src={imgSrc}
            srcSet={srcSet ?? undefined}
            sizes={srcSet ? '(min-width: 1024px) 640px, 100vw' : undefined}
            alt={caption || image.slug}
            loading="lazy"
            decoding="async"
            className={`h-full w-full object-contain transition-[transform,filter] duration-300 group-hover:scale-[1.01]${image.isNsfw ? ' [filter:blur(2px)] group-hover:[filter:blur(0px)]' : ''}`}
          />
        </div>
        <div className="space-y-2 p-3">
          {caption ? (
            <p className="prose-caption line-clamp-2 text-sm text-ink-100">{caption}</p>
          ) : (
            <p className="font-mono text-xs text-ink-500">{image.slug}</p>
          )}
          {tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => (
                <span key={t.id} className="chip">
                  {t.tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </Link>
      <CardEngagement
        slug={image.slug}
        initialCounts={image.reactionCounts ?? { up: 0, down: 0 }}
        commentCount={image.commentCount ?? 0}
        uploadedAt={image.uploadedAt}
      />
    </div>
  );
}
