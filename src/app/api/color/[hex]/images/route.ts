import { NextResponse } from 'next/server';
import { listImagesByPaletteHex, normalizeHex } from '@/lib/db/queries/palette';
import { readShowNsfwCookie } from '@/lib/nsfw';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Paginated palette-color feed for the infinite-scroll client. Returns
// `{ images: ImageWithRelations[] }` to match the other gallery feeds.
export async function GET(
  req: Request,
  { params }: { params: { hex: string } }
) {
  const url = new URL(req.url);
  const limit = parseIntParam(url.searchParams.get('limit'), 24);
  const offset = parseIntParam(url.searchParams.get('offset'), 0);

  const queryIncludeNsfw = url.searchParams.get('include_nsfw');
  const includeNsfw =
    queryIncludeNsfw === '1' || queryIncludeNsfw === 'true'
      ? true
      : await readShowNsfwCookie();

  const raw = decodeURIComponent(params.hex);
  const normalized = normalizeHex(raw.startsWith('#') ? raw : `#${raw}`);
  if (!normalized) return NextResponse.json({ images: [] }, { status: 400 });

  const images = await listImagesByPaletteHex(normalized, {
    limit,
    offset,
    includeNsfw
  }).catch(() => []);
  return NextResponse.json({ images });
}

function parseIntParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
