import { NextResponse } from 'next/server';
import { getFishMorphConfig } from '@/lib/db/queries/fish-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public read for the mascot. The pix-fish component (rendered for every
// visitor, signed-in or not) fetches this on mount to drive its morph. Cached
// briefly at the edge since the config changes rarely and a few seconds of
// staleness on an aesthetic tweak is fine.
export async function GET() {
  const config = await getFishMorphConfig();
  return NextResponse.json(
    { config },
    { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' } }
  );
}
