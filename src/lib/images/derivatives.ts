// Precomputed image derivatives. scripts/generate-derivatives.ts resizes each
// original to a small set of WebP widths, uploads them to the same Vercel Blob
// store, and records the result here (persisted on images.derivatives). The web
// app reads these so gallery tiles serve a small derivative instead of the raw
// original, and the optimizer never re-transforms originals at request time.
//
// `derivatives` is null for rows the script has not processed yet (legacy rows,
// or new uploads before the next backfill run). Every consumer must fall back
// to the original blobUrl in that case, so nothing breaks mid-migration.

// Target widths, smallest to largest. Downscale-only: the script skips any
// width >= the original's width, so a small original yields fewer entries.
// 1280 exists so a 640px-wide desktop tile stays crisp at 2x DPR.
export const DERIVATIVE_WIDTHS = [320, 640, 1024, 1280] as const;

export type ImageDerivative = {
  // Rendered width in pixels.
  w: number;
  // Public Blob URL of the WebP at that width.
  url: string;
};

// Stored shape of images.derivatives: the widths actually generated for a row,
// ascending by `w`. May be a subset of DERIVATIVE_WIDTHS for small originals.
export type ImageDerivatives = ImageDerivative[];

function sorted(derivatives: ImageDerivatives): ImageDerivatives {
  return [...derivatives].sort((a, b) => a.w - b.w);
}

// Build a `srcset` string ("url 320w, url 640w, ...") from the stored set.
// Returns null when there are no derivatives so callers fall back to the
// original.
export function buildSrcSet(derivatives: ImageDerivatives | null | undefined): string | null {
  if (!derivatives || derivatives.length === 0) return null;
  return sorted(derivatives)
    .map((d) => `${d.url} ${d.w}w`)
    .join(', ');
}

// The largest available derivative URL (used as the <img src> fallback for
// browsers that ignore srcset, and as the detail page's default image). Returns
// null when there are no derivatives.
export function largestDerivativeUrl(
  derivatives: ImageDerivatives | null | undefined
): string | null {
  if (!derivatives || derivatives.length === 0) return null;
  return sorted(derivatives).at(-1)?.url ?? null;
}

// The smallest available derivative URL (used for tiny neighbor thumbnails).
export function smallestDerivativeUrl(
  derivatives: ImageDerivatives | null | undefined
): string | null {
  if (!derivatives || derivatives.length === 0) return null;
  return sorted(derivatives)[0]?.url ?? null;
}
