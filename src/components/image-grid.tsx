import { ImageCard } from './image-card';
import type { ImageWithRelations } from '@/lib/db/queries/images';

type Props = {
  images: ImageWithRelations[];
  // Optional per-image similarity (0..1). Passing a non-empty map turns
  // on the small percentage badge in the top-right corner of each card.
  similarities?: Map<number, number>;
};

export function ImageGrid({ images, similarities }: Props) {
  if (images.length === 0) {
    return (
      <p className="py-24 text-center font-mono text-sm text-ink-500">
        no pictures here yet
      </p>
    );
  }
  // Single centered column. Each card keeps its intrinsic aspect ratio so
  // portraits and landscapes both render uncropped at column width.
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-10">
      {images.map((img) => (
        <ImageCard
          key={img.id}
          image={img}
          similarity={similarities?.get(img.id)}
        />
      ))}
    </div>
  );
}
