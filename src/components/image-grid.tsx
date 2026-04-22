import { ImageCard } from './image-card';
import type { ImageWithRelations } from '@/lib/db/queries/images';

export function ImageGrid({ images }: { images: ImageWithRelations[] }) {
  if (images.length === 0) {
    return (
      <p className="py-24 text-center font-mono text-sm text-ink-500">
        no pictures here yet
      </p>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {images.map((img) => (
        <ImageCard key={img.id} image={img} />
      ))}
    </div>
  );
}
