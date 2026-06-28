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
          // The result depends on the visitor's NSFW cookie, so it must never
          // sit in a shared/CDN cache where an opted-in response could be served
          // to a default hide-NSFW visitor. Keep it per-client and uncached.
          'cache-control': 'private, no-store',
          vary: 'Cookie'
        }
      }
    );
  } catch (err) {
    console.error('api/chronicle failed', err);
    return NextResponse.json({ error: 'chronicle unavailable' }, { status: 503 });
  }
}
