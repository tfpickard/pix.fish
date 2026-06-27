import { NextResponse } from 'next/server';
import { loadChronicleEntries } from '@/lib/universe/chronicle-load';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// JSON feed of the chronicle (the canon activity log). Mirrors feed.json's
// short-cache delivery. Read-only over the append-only events.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 60) | 0, 1), 200);

  try {
    const entries = await loadChronicleEntries(limit);
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
