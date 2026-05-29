import { NextResponse } from 'next/server';
import { readBasementCookie } from '@/lib/basement';
import { listBasementImages, countBasementImages } from '@/lib/db/queries/basement';
import { parseIntParam } from '@/lib/http-params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public-facing basement image feed -- but only for unlocked visitors.
// The cookie check runs server-side so the blob URLs are never shipped
// to a locked visitor; they get a 403 with no image data.
export async function GET(req: Request) {
  const unlocked = await readBasementCookie();
  if (!unlocked) {
    return NextResponse.json({ error: 'basement locked' }, { status: 403 });
  }

  const url = new URL(req.url);
  const limit = parseIntParam(url.searchParams.get('limit'), 24);
  const offset = parseIntParam(url.searchParams.get('offset'), 0);

  const [images, total] = await Promise.all([
    listBasementImages({ limit, offset }),
    countBasementImages()
  ]);

  return NextResponse.json({ images, total });
}
