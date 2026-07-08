import { runRandom } from '@/lib/random/handler';
import { fetchImageDataUri, MAX_DATA_URI_BYTES } from '@/lib/random/serialize';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/uri -- the image as a base64 data: URI so a client can embed
// it inline (e.g. an <img src>) without a second request. Originals over
// MAX_DATA_URI_BYTES are rejected with 413 (use /image or /raw instead).
export function GET(req: Request) {
  return runRandom(req, async (row) => {
    const result = await fetchImageDataUri(row);
    if (!result.ok) {
      if (result.reason === 'too_large') {
        return jsonRandom(
          {
            error: 'image too large to inline as a data URI; use /api/random/image or /api/random/raw',
            maxBytes: MAX_DATA_URI_BYTES
          },
          413
        );
      }
      return jsonRandom({ error: 'image unavailable' }, 502);
    }
    return jsonRandom({
      slug: row.slug,
      dataUri: result.dataUri,
      mime: result.mime,
      sizeBytes: result.sizeBytes
    });
  });
}
