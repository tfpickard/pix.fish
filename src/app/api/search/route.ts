import { NextResponse } from 'next/server';
import { getEmbedder, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { searchByVector } from '@/lib/db/queries/embeddings';
import { getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';
import { getSiteAdminId } from '@/lib/db/queries/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) {
    return NextResponse.json({ error: 'q is required' }, { status: 400 });
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 24) | 0, 1), 100);

  // Visitor-side semantic search runs against the site admin's keys so
  // unauthenticated visitors can still query. Per-user keys are billed by
  // the user; using site admin's here means the admin's OpenAI account
  // pays for visitor queries -- intentional, matches the public-by-default
  // visibility model.
  const cfg = await loadAiConfig();
  const adminKeys = await loadUserProviderKeys(getSiteAdminId());
  const embedder = getEmbedder(cfg, adminKeys);
  if (!embedder) {
    return NextResponse.json({ error: 'search unavailable' }, { status: 503 });
  }

  let vec: number[];
  try {
    vec = await embedder.embed(q);
  } catch (err) {
    console.error('query embedding failed', err);
    return NextResponse.json({ error: 'search failed' }, { status: 502 });
  }

  try {
    const matches = await searchByVector(vec, { limit, kind: 'caption' });
    const rows = await getImagesByIdsOrdered(matches.map((m) => m.imageId));
    const hydrated = await hydrateImages(rows);
    return NextResponse.json({ q, images: hydrated });
  } catch (err) {
    // Covers missing embeddings table, pgvector extension not installed,
    // or any downstream DB failure. Match the JSON error shape from the
    // embedder branches above instead of throwing a raw 500.
    console.error('search query failed', err);
    return NextResponse.json({ error: 'search unavailable' }, { status: 503 });
  }
}
