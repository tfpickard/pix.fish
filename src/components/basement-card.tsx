'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { ImageWithRelations } from '@/lib/db/queries/images';

type Props = {
  image: ImageWithRelations;
};

// Basement card: same structural shape as ImageCard but with a shifted
// aesthetic -- near-black surface, sickly green text, no engagement bar.
// The link points to the main image detail page (/[slug] or /u/handle/slug)
// because basement images are real images -- only their listing is gated.
export function BasementCard({ image }: Props) {
  // Same deterministic pick as ImageCard so captions are stable across renders.
  const caption = useMemo(() => {
    if (image.captions.length === 0) return '';
    const idx = ((image.id % image.captions.length) + image.captions.length) % image.captions.length;
    return image.captions[idx]?.text ?? '';
  }, [image.id, image.captions]);

  const aspect = image.width && image.height ? image.width / image.height : 1;

  return (
    <div className="group relative overflow-hidden rounded-sm border border-[#1a3e1a] bg-[#050e05]">
      <Link href={`/${image.slug}`} className="block">
        <div className="relative w-full" style={{ aspectRatio: aspect }}>
          {/* No next/image here -- next/image requires remotePatterns config
              and basement images use the same Vercel Blob domain as the rest.
              The <img> tag is fine; the pre-existing lint exception covers it. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.blobUrl}
            alt={caption || image.slug}
            className="h-full w-full object-contain opacity-85 grayscale-[0.3] transition-all duration-300 group-hover:opacity-100 group-hover:grayscale-0"
          />
        </div>
        <div className="space-y-1.5 p-3">
          {caption ? (
            <p className="line-clamp-2 font-mono text-xs text-[#7fff7f]">{caption}</p>
          ) : (
            <p className="font-mono text-xs text-[#2a4e2a]">{image.slug}</p>
          )}
          {image.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {image.tags.slice(0, 4).map((t) => (
                <span
                  key={t.id}
                  className="rounded-sm border border-[#1a3e1a] px-1 py-0.5 font-mono text-[10px] text-[#4a6e4a]"
                >
                  {t.tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </Link>
    </div>
  );
}
