/**
 * Pure-JS EXIF + palette extraction from an upload buffer.
 *
 * Both helpers never throw. Failure means the upload still succeeds -- we just
 * miss that metadata on the row and can backfill later. Matches the Phase 1
 * "image survives enrichment failure" rule in CLAUDE.md.
 */
import exifr from 'exifr';
import { Vibrant } from 'node-vibrant/node';

export type ExtractedExif = Record<string, unknown>;

// Whitelist of EXIF fields we care about. exifr by default returns everything
// including thumbnail binary data -- too big for jsonb and mostly noise.
const EXIF_KEYS = [
  'Make',
  'Model',
  'LensModel',
  'FocalLength',
  'FocalLengthIn35mmFormat',
  'FNumber',
  'ExposureTime',
  'ISO',
  'DateTimeOriginal',
  'CreateDate',
  'ModifyDate',
  'Orientation',
  'GPSLatitude',
  'GPSLongitude',
  'GPSAltitude',
  'Software',
  'Artist',
  'Copyright'
] as const;

export async function extractExif(buffer: Buffer): Promise<{
  exif: ExtractedExif | null;
  takenAt: Date | null;
}> {
  try {
    const parsed = await exifr.parse(buffer, {
      pick: EXIF_KEYS as unknown as string[],
      translateValues: true,
      reviveValues: true
    });
    if (!parsed || typeof parsed !== 'object') return { exif: null, takenAt: null };

    // Strip undefined so we don't persist a bag of nulls.
    const exif: ExtractedExif = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === undefined || v === null) continue;
      exif[k] = v instanceof Date ? v.toISOString() : v;
    }
    if (Object.keys(exif).length === 0) return { exif: null, takenAt: null };

    const takenRaw = parsed.DateTimeOriginal ?? parsed.CreateDate ?? null;
    const takenAt = takenRaw instanceof Date ? takenRaw : null;
    return { exif, takenAt };
  } catch (err) {
    console.error('exif extract failed', err);
    return { exif: null, takenAt: null };
  }
}

// Returns up to 6 hex color strings in rough prominence order. Vibrant gives
// us named swatches (Vibrant, Muted, DarkVibrant, etc.); we order by
// population so the most-used color comes first.
export async function extractPalette(buffer: Buffer): Promise<string[]> {
  try {
    const palette = await Vibrant.from(buffer).getPalette();
    const swatches = Object.values(palette).filter((s): s is NonNullable<typeof s> => !!s);
    swatches.sort((a, b) => b.population - a.population);
    const hexes = swatches.map((s) => s.hex).filter(Boolean);
    // dedupe while preserving order
    return Array.from(new Set(hexes));
  } catch (err) {
    console.error('palette extract failed', err);
    return [];
  }
}
