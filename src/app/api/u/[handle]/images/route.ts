import { NextResponse } from 'next/server';
import { listImagesByHandle } from '@/lib/db/queries/images';
import { parseIntParam, resolveNsfwMode } from '@/lib/http-params';

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
  const nsfwMode = await resolveNsfwMode(url.searchParams.get('include_nsfw'));

  const handle = decodeURIComponent(params.handle).toLowerCase();
  const { owner, images } = await listImagesByHandle(handle, {
    limit,
    offset,
    nsfwMode
  });
  if (!owner) return NextResponse.json({ images: [] }, { status: 404 });
  return NextResponse.json({ images });
}
