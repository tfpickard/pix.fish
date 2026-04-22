import Image from 'next/image';
import Link from 'next/link';
import { pickOne } from '@/lib/random';
import type { ImageWithRelations } from '@/lib/db/queries/images';

export function ImageCard({ image }: { image: ImageWithRelations }) {
  const caption = pickOne(image.captions)?.text ?? '';
  const tags = image.tags.slice(0, 5);
  const aspect = image.width && image.height ? image.width / image.height : 1;

  return (
    <Link
      href={`/${image.slug}`}
      className="neon-card group relative block overflow-hidden rounded-md border border-ink-800/80 bg-ink-900/30"
    >
      <div className="relative w-full" style={{ aspectRatio: aspect }}>
        {image.width && image.height ? (
          <Image
            src={image.blobUrl}
            alt={caption || image.slug}
            width={image.width}
            height={image.height}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
          />
        ) : (
          <img
            src={image.blobUrl}
            alt={caption || image.slug}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
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
  );
}
