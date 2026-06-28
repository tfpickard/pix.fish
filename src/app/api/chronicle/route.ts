import { NextResponse } from 'next/server';
import { loadChronicleEntries } from '@/lib/universe/chronicle-load';
import { resolveNsfwMode } from '@/lib/http-params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// JSON feed of the chronicle (the canon activity log). Mirrors feed.json's
// short-cache delivery. Read-only over the append-only events. Specimen entries
// respect the same NSFW visibility rule as the gallery (cookie, overridable via
// ?include_nsfw= for admin tooling).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 60) | 0, 1), 200);
  const nsfwMode = await resolveNsfwMode(url.searchParams.get('include_nsfw'));

  try {
    const entries = await loadChronicleEntries(limit, nsfwMode);
    return NextResponse.json(
      { entries },
      {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=300, s-maxage=300'
        }
      }
    );
  } catch (err) {
    console.error('api/chronicle failed', err);
    return NextResponse.json({ error: 'chronicle unavailable' }, { status: 503 });
  }
}
