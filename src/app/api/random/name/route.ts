import { runRandom } from '@/lib/random/handler';
import { fileNameFor } from '@/lib/random/serialize';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/name -- the image's name (its slug), plus a download filename.
export function GET(req: Request) {
  return runRandom(req, (row) =>
    jsonRandom({ name: row.slug, slug: row.slug, filename: fileNameFor(row) })
  );
}
