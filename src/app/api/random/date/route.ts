import { runRandom } from '@/lib/random/handler';
import { jsonRandom } from '@/lib/random/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { optionsResponse as OPTIONS } from '@/lib/random/http';

// GET /api/random/date -- the image's date. `date` is the best available: when
// the photo was taken (EXIF) if known, else when it was uploaded. Both raw
// fields are returned too.
export function GET(req: Request) {
  return runRandom(req, (row) =>
    jsonRandom({
      slug: row.slug,
      date: (row.takenAt ?? row.uploadedAt).toISOString(),
      takenAt: row.takenAt ? row.takenAt.toISOString() : null,
      uploadedAt: row.uploadedAt.toISOString()
    })
  );
}
