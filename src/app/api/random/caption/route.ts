import { runRandom } from '@/lib/random/handler';
import { hydrateImages } from '@/lib/db/queries/images';
import { pickVariant } from '@/lib/random/serialize';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/caption -- a caption for the image. `caption` is a random
// variant (server-side per request, matching the app); all variants are
// returned alongside, plus any manual caption.
export function GET(req: Request) {
  return runRandom(req, async (row) => {
    const [hydrated] = await hydrateImages([row]);
    const variants = (hydrated?.captions ?? []).map((c) => c.text);
    return jsonRandom({
      slug: row.slug,
      caption: pickVariant(variants),
      variants,
      manualCaption: row.manualCaption
    });
  });
}
