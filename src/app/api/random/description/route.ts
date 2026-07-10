import { runRandom } from '@/lib/random/handler';
import { hydrateImages } from '@/lib/db/queries/images';
import { pickVariant } from '@/lib/random/serialize';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/description -- a description for the image. `description` is a
// random variant (server-side per request); all variants are returned too.
export function GET(req: Request) {
  return runRandom(req, async (row) => {
    const [hydrated] = await hydrateImages([row]);
    const variants = (hydrated?.descriptions ?? []).map((d) => d.text);
    return jsonRandom({ slug: row.slug, description: pickVariant(variants), variants });
  });
}
