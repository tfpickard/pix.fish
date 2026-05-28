import { NextResponse } from 'next/server';
import { listImagesByHandle } from '@/lib/db/queries/images';
import { readShowNsfwCookie } from '@/lib/nsfw';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Paginated handle gallery feed for the infinite-scroll client. Mirrors
// the GET shape of /api/images (returns `{ images: ImageWithRelations[] }`)
// so InfiniteImageGrid doesn't branch per endpoint.
export async function GET(
  req: Request,
  { params }: { params: { handle: string } }
) {
  const url = new URL(req.url);
  const limit = parseIntParam(url.searchParams.get('limit'), 24);
  const offset = parseIntParam(url.searchParams.get('offset'), 0);

  const queryIncludeNsfw = url.searchParams.get('include_nsfw');
  const includeNsfw =
    queryIncludeNsfw === '1' || queryIncludeNsfw === 'true'
      ? true
      : await readShowNsfwCookie();

  const handle = decodeURIComponent(params.handle).toLowerCase();
  const { owner, images } = await listImagesByHandle(handle, {
    limit,
    offset,
    includeNsfw
  });
  if (!owner) return NextResponse.json({ images: [] }, { status: 404 });
  return NextResponse.json({ images });
}

function parseIntParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
