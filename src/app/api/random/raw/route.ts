import { runRandom } from '@/lib/random/handler';
import { fetchImageStream, fileNameFor } from '@/lib/random/serialize';
import { bytesRandom, jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/raw -- the same proxied original bytes as /image, but served
// as a download (Content-Disposition: attachment). "Give me the file."
export function GET(req: Request) {
  return runRandom(req, async (row) => {
    const upstream = await fetchImageStream(row.blobUrl);
    if (!upstream) return jsonRandom({ error: 'image unavailable' }, 502);
    const contentType =
      row.mime || upstream.headers.get('content-type') || 'application/octet-stream';
    return bytesRandom(upstream.body, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${fileNameFor(row)}"`
    });
  });
}
