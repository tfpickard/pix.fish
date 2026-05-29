'use client';

import { useMemo } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { ImageWithRelations } from '@/lib/db/queries/images';
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
  const similarityLabel =
    typeof similarity === 'number' && Number.isFinite(similarity)
      ? `${Math.round(Math.max(0, Math.min(1, similarity)) * 100)}%`
      : null;

  return (
    <div className="neon-card group relative overflow-hidden rounded-md border border-ink-800/80 bg-ink-900/30">
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
            <span className="absolute left-2 top-2 z-10 rounded-sm border border-amber-500/60 bg-ink-950/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-400">
              nsfw
            </span>
          ) : null}
          {image.width && image.height ? (
            <Image
              src={image.blobUrl}
              alt={caption || image.slug}
              width={image.width}
              height={image.height}
              // object-contain preserves the original aspect so a portrait and
              // a landscape both show uncropped; the parent's aspectRatio is
              // computed from the image itself so there's no letterboxing in
              // practice.
              className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.01]"
              sizes="(min-width: 1024px) 640px, 100vw"
            />
          ) : (
            <img
              src={image.blobUrl}
              alt={caption || image.slug}
              className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.01]"
            />
          )}
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
