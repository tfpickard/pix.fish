import { runRandom } from '@/lib/random/handler';
import { fetchImageDataUri } from '@/lib/random/serialize';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/uri -- the image as a base64 data: URI so a client can embed
// it inline (e.g. an <img src>) without a second request.
export function GET(req: Request) {
  return runRandom(req, async (row) => {
    const result = await fetchImageDataUri(row);
    if (!result) return jsonRandom({ error: 'image unavailable' }, 502);
    return jsonRandom({ slug: row.slug, ...result });
  });
}
