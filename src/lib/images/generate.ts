import { put } from '@vercel/blob';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '@/lib/db/client';
import { images } from '@/lib/db/schema';
import {
  DERIVATIVE_WIDTHS,
  type ImageDerivative,
  type ImageDerivatives
} from './derivatives';

// Core derivative generation, shared by the offline backfill
// (scripts/generate-derivatives.ts) and the post-upload `derive.image` job
// (src/lib/jobs/handlers/deriveImage.ts) so both paths produce identical files
// and naming. Resizes an original to a small WebP ladder, uploads each next to
// the original in Vercel Blob, and records the URLs on images.derivatives.
//
// Requires BLOB_READ_WRITE_TOKEN (write) in the environment, same as uploads.

const WEBP_QUALITY = 80;
const MAX_WIDTH = DERIVATIVE_WIDTHS[DERIVATIVE_WIDTHS.length - 1];

// The set of widths to render for a given original width. Downscale-only:
// never request a width larger than the original. Always include a top entry at
// min(originalWidth, MAX_WIDTH) so even a small original yields one compressed
// WebP and the detail view has a "largest" to show. Unknown width -> full
// ladder, with sharp's withoutEnlargement clamping each.
export function targetWidths(originalWidth: number | undefined): number[] {
  if (originalWidth === undefined) return [...DERIVATIVE_WIDTHS];
  const set = new Set<number>(DERIVATIVE_WIDTHS.filter((w) => w < originalWidth));
  set.add(Math.min(originalWidth, MAX_WIDTH));
  return [...set].sort((a, b) => a - b);
}

// `<base>.w<width>.webp` from the original blob key, dropping the original
// extension. Stable per (image, width) so reruns overwrite rather than fork.
export function derivativeKey(blobKey: string, width: number): string {
  const base = blobKey.replace(/\.[a-zA-Z0-9]+$/, '');
  return `${base}.w${width}.webp`;
}

// Generate + upload derivatives for one image and persist images.derivatives.
// Returns the number of derivative files written (0 for animated originals,
// which are skipped). Best-effort by contract: callers should treat a throw as
// "leave the row on its original" since every consumer falls back to blobUrl.
export async function generateImageDerivatives(row: {
  id: number;
  blobUrl: string;
  blobKey: string;
}): Promise<number> {
  const res = await fetch(row.blobUrl);
  if (!res.ok) throw new Error(`fetch original ${res.status}`);
  const original = Buffer.from(await res.arrayBuffer());

  const meta = await sharp(original).metadata();

  // Animated originals (GIF / animated WebP): a plain sharp() pipeline decodes
  // only the first frame, so a derivative would be a still. Since the gallery
  // prefers derivatives over the original, that would silently freeze animated
  // images. Skip them -- record an empty set so the row is marked processed
  // (not retried) and every consumer falls back to the original, which keeps
  // animating.
  if ((meta.pages ?? 1) > 1) {
    await db.update(images).set({ derivatives: [] }).where(eq(images.id, row.id));
    return 0;
  }

  // Dedupe by the ACTUAL output width (withoutEnlargement can collapse two
  // requested widths onto the same real width when the original is small).
  const byWidth = new Map<number, ImageDerivative>();
  for (const width of targetWidths(meta.width)) {
    const { data, info } = await sharp(original)
      // Honor EXIF orientation so derivatives are never sideways.
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    const blob = await put(derivativeKey(row.blobKey, info.width), data, {
      access: 'public',
      contentType: 'image/webp',
      addRandomSuffix: false
      // @vercel/blob 0.27.x overwrites an existing key by default (no
      // allowOverwrite option). On v1+, which rejects overwrites by default,
      // add `allowOverwrite: true` here so reruns/repairs don't throw.
    });
    byWidth.set(info.width, { w: info.width, url: blob.url });
  }

  const derivatives: ImageDerivatives = [...byWidth.values()].sort((a, b) => a.w - b.w);
  await db.update(images).set({ derivatives }).where(eq(images.id, row.id));
  return derivatives.length;
}
