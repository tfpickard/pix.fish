import { runRandom } from '@/lib/random/handler';
import { countReactions } from '@/lib/db/queries/reactions';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/dislikes -- the dislike count (thumbs-down reactions).
export function GET(req: Request) {
  return runRandom(req, async (row) => {
    const { down } = await countReactions(row.id);
    return jsonRandom({ slug: row.slug, dislikes: down });
  });
}
