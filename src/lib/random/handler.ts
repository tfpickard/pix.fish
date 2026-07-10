import type { NextResponse } from 'next/server';
import type { Image } from '@/lib/db/schema';
import { selectImage } from './select';
import { jsonRandom, notFoundRandom } from './http';

// Shared wrapper for every /api/random/* GET handler. Selects the image (random
// or pinned), returns a CORS-carrying 404 when nothing matches, runs the route's
// serializer, and turns any thrown error (e.g. DB unavailable) into a structured
// 500 that still carries CORS + no-store -- so the public API never leaks Next's
// HTML error page to a cross-origin caller.
export async function runRandom(
  req: Request,
  fn: (row: Image) => Promise<NextResponse> | NextResponse
): Promise<NextResponse> {
  let row: Image | null;
  try {
    row = await selectImage(req);
  } catch (err) {
    console.error('random: image selection failed', err);
    return jsonRandom({ error: 'internal error' }, 500);
  }
  if (!row) return notFoundRandom();
  try {
    return await fn(row);
  } catch (err) {
    console.error('random: response build failed', err);
    return jsonRandom({ error: 'internal error' }, 500);
  }
}
