'use client';

import { useState, useTransition } from 'react';
import type { ImageWithRelations } from '@/lib/db/queries/images';
import { BasementCard } from './basement-card';

type Props = {
  initial: ImageWithRelations[];
  total: number;
};

// Client-side infinite scroll for the basement gallery. Mirrors the
// InfiniteImageGrid pattern but hits /api/basement/images instead of
// /api/images, and uses the basement card aesthetic instead of the
// main gallery card.
export function BasementGrid({ initial, total }: Props) {
  const [images, setImages] = useState(initial);
  const [offset, setOffset] = useState(initial.length);
  const [isPending, startTransition] = useTransition();
  const hasMore = images.length < total;

  function loadMore() {
    startTransition(async () => {
      const res = await fetch(`/api/basement/images?limit=24&offset=${offset}`);
      if (!res.ok) return;
      const data = (await res.json()) as { images: ImageWithRelations[] };
      setImages((prev) => [...prev, ...data.images]);
      setOffset((prev) => prev + data.images.length);
    });
  }

  if (images.length === 0) {
    return (
      <p className="font-mono text-xs text-[#4a6e4a]">
        nothing down here yet. an admin can move images to the basement.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {images.map((img) => (
          <BasementCard key={img.id} image={img} />
        ))}
      </div>

      {hasMore ? (
        <div className="pt-4 text-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={isPending}
            className="font-mono text-xs text-[#4a6e4a] underline-offset-2 hover:text-[#7fff7f] disabled:opacity-50"
          >
            {isPending ? 'loading...' : 'go deeper'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
