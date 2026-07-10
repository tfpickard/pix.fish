import { runRandom } from '@/lib/random/handler';
import { listApprovedComments } from '@/lib/db/queries/comments';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/comments (and /api/random/comments/) -- the approved public
// comments on the image, newest first.
export function GET(req: Request) {
  return runRandom(req, async (row) => {
    const comments = await listApprovedComments(row.id);
    return jsonRandom({ slug: row.slug, comments });
  });
}
