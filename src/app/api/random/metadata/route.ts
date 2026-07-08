import { runRandom } from '@/lib/random/handler';
import { getImageSizeBytes } from '@/lib/random/serialize';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/metadata -- the stored technical metadata (EXIF is already
// GPS-stripped at upload time), palette, dimensions, mime, dates, and flags.
export function GET(req: Request) {
  return runRandom(req, async (row) =>
    jsonRandom({
      slug: row.slug,
      mime: row.mime,
      width: row.width,
      height: row.height,
      sizeBytes: await getImageSizeBytes(row.blobUrl),
      palette: row.palette,
      exif: row.exif,
      takenAt: row.takenAt ? row.takenAt.toISOString() : null,
      uploadedAt: row.uploadedAt.toISOString(),
      isNsfw: row.isNsfw,
      nsfwSource: row.nsfwSource,
      generation: row.generation,
      derivatives: row.derivatives ?? null
    })
  );
}
