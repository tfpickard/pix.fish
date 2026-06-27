'use client';

// Client-only wrapper that does the next/dynamic import so the Server Component
// page (app/manifold/page.tsx) is never the one calling dynamic({ssr:false}).
// Next.js App Router rejects ssr:false dynamic imports from Server Components;
// they must originate from a 'use client' boundary.

import dynamic from 'next/dynamic';
import type { ManifoldPoint, ManifoldImage, ManifoldLore } from './manifold-scene';

const ManifoldScene = dynamic(
  () => import('./manifold-scene').then((m) => m.ManifoldScene),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[600px] items-center justify-center rounded border border-ink-800 bg-ink-950 font-mono text-xs text-ink-500">
        loading scene...
      </div>
    )
  }
);

type Props = {
  points: ManifoldPoint[];
  images: ManifoldImage[];
  lore?: ManifoldLore[];
};

export function ManifoldSceneClient({ points, images, lore }: Props) {
  return <ManifoldScene points={points} images={images} lore={lore} />;
}
