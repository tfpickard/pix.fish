import { runRandom } from '@/lib/random/handler';
import { buildFullRecord } from '@/lib/random/serialize';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random -- a random image and everything stored about it as JSON.
// Accepts ?id= / ?slug= to pin a specific image and ?include_nsfw=1|true|only.
export function GET(req: Request) {
  return runRandom(req, async (row) => jsonRandom(await buildFullRecord(row)));
}
