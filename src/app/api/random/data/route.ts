import { runRandom } from '@/lib/random/handler';
import { buildFullRecord } from '@/lib/random/serialize';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/data -- alias of /api/random: the full JSON record.
export function GET(req: Request) {
  return runRandom(req, async (row) => jsonRandom(await buildFullRecord(row)));
}
