import { runRandom } from '@/lib/random/handler';
import { countReactions } from '@/lib/db/queries/reactions';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/likes -- the like count (thumbs-up reactions).
export function GET(req: Request) {
  return runRandom(req, async (row) => {
    const { up } = await countReactions(row.id);
    return jsonRandom({ slug: row.slug, likes: up });
  });
}
