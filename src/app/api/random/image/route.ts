import { runRandom } from '@/lib/random/handler';
import { fetchImageStream } from '@/lib/random/serialize';
import { bytesRandom, jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/image -- proxy the image bytes INLINE so a browser renders a
// random picture at a stable pix.fish URL (the headline browser use case). The
// blob host is never exposed. Accepts the same ?id=/?slug=/?include_nsfw= params.
export function GET(req: Request) {
  return runRandom(req, async (row) => {
    const upstream = await fetchImageStream(row.blobUrl);
    if (!upstream) return jsonRandom({ error: 'image unavailable' }, 502);
    const contentType =
      row.mime || upstream.headers.get('content-type') || 'application/octet-stream';
    return bytesRandom(upstream.body, {
      'Content-Type': contentType,
      'Content-Disposition': 'inline'
    });
  });
}
