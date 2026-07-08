import { runRandom } from '@/lib/random/handler';
import { getImageSizeBytes } from '@/lib/random/serialize';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/size -- the image size in bytes (HEAD on the blob; null if the
// blob host doesn't report content-length).
export function GET(req: Request) {
  return runRandom(req, async (row) =>
    jsonRandom({ slug: row.slug, sizeBytes: await getImageSizeBytes(row.blobUrl) })
  );
}
