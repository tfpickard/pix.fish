'use client';

// Filmstrip of images along a geodesic path through the kNN graph.
//
// Props receive the ordered path from /api/path. Each image links to its
// canonical detail page (/u/<handle>/<slug> when handle is known, else
// /<slug> as fallback for backcompat).
//
// MANIFOLD INTEGRATION SEAM (deferred, pending feat/manifold merge)
// -----------------------------------------------------------------
// Once feat/manifold lands, the 3D polyline overlay needs:
//   - The ordered imageId array: path.map(n => n.imageId)
//   - The per-node coordinates from the manifold projection
// Export `pathImageIds` from this component (or from the parent page) and
// pass them to the ManifoldScene with a "highlight-path" prop. The manifold
// component already handles id -> {x,y,z} lookup via its projection store.
// No changes to this file are needed; the seam is at the page level.

import Link from 'next/link';
import type { PathNode } from '@/lib/knn-path-types';

type Props = {
  path: PathNode[];
  totalDist: number;
};

// Build the canonical detail URL. /u/<handle>/<slug> when handle is set,
// otherwise fall back to the legacy /<slug> URL so the link is never broken.
function detailUrl(node: PathNode): string {
  if (node.handle) return `/u/${node.handle}/${node.slug}`;
  return `/${node.slug}`;
}

export function PathFilmstrip({ path, totalDist }: Props) {
  if (path.length === 0) return null;

  // The first and last nodes are the user-chosen endpoints; everything in
  // between is the intermediate path. We distinguish them visually so the
  // user can see which images they picked vs. which are "stepping stones."
  const endpointIds = new Set([path[0]!.imageId, path[path.length - 1]!.imageId]);

  return (
    <div className="space-y-4">
      <p className="font-mono text-xs text-ink-500">
        {path.length} image{path.length === 1 ? '' : 's'} &middot;{' '}
        {path.length >= 2 ? path.length - 2 : 0} intermediate step{path.length - 2 === 1 ? '' : 's'} &middot;{' '}
        total distance {totalDist.toFixed(3)}
      </p>

      {/* Horizontal scroll container. On narrow viewports the filmstrip
          scrolls horizontally rather than wrapping so the path order stays
          visually linear and readable as a sequence. */}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {path.map((node, idx) => {
          const isEndpoint = endpointIds.has(node.imageId);
          const isLast = idx === path.length - 1;

          return (
            <div key={node.imageId} className="flex shrink-0 items-center gap-3">
              {/* Image card */}
              <Link
                href={detailUrl(node)}
                className="group block w-40 shrink-0 overflow-hidden rounded-md border border-ink-800/80 bg-ink-900/30 transition-colors hover:border-primary/50"
                title={node.caption || node.slug}
              >
                {/* Fixed-square thumbnail. The filmstrip works best with
                    uniform thumbnail heights so the connector arrows stay
                    at consistent vertical positions. */}
                <div className="relative h-32 w-full overflow-hidden bg-ink-950">
                  <img
                    src={node.blobUrl}
                    alt={node.caption || node.slug}
                    className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                  />
                  {/* Endpoint badge: marks the two user-chosen images */}
                  {isEndpoint ? (
                    <span className="absolute right-1.5 top-1.5 rounded-sm border border-primary/60 bg-ink-950/80 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary">
                      {idx === 0 ? 'A' : 'B'}
                    </span>
                  ) : (
                    <span className="absolute right-1.5 top-1.5 rounded-sm border border-ink-700/60 bg-ink-950/70 px-1.5 py-0.5 font-mono text-[9px] text-ink-400">
                      {idx + 1}
                    </span>
                  )}
                </div>
                <div className="p-2">
                  <p className="line-clamp-2 font-mono text-[10px] text-ink-300">
                    {node.caption || node.slug}
                  </p>
                </div>
              </Link>

              {/* Arrow connector between nodes, hidden after the last node. */}
              {!isLast ? (
                <span className="shrink-0 font-mono text-xs text-ink-600" aria-hidden="true">
                  &rarr;
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Re-export the ordered imageId array so a future manifold overlay can
// consume the path without re-fetching. See the integration seam note above.
export function extractPathImageIds(path: PathNode[]): number[] {
  return path.map((n) => n.imageId);
}
