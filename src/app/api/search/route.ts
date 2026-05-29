import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getEmbedder, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { searchByVector } from '@/lib/db/queries/embeddings';
import { getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { BASEMENT_COOKIE, BASEMENT_PASSPHRASE, readBasementCookie } from '@/lib/basement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) {
    return NextResponse.json({ error: 'q is required' }, { status: 400 });
  }

  // Passphrase unlock ritual: if the query exactly matches the basement
  // passphrase (case-insensitive) we set the unlock cookie and return a
  // special "no results" signal. The search UI sees zero images and no
  // error, and separately the client polls for the basement cookie to
  // decide whether to show the door. Returning 0 results (not 404) keeps
  // the ritual undiscoverable from the wire -- it just looks like a weird
  // search with no matches.
  if (q.toLowerCase() === BASEMENT_PASSPHRASE.toLowerCase()) {
    const store = await cookies();
    store.set(BASEMENT_COOKIE, 'unlocked', {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7
    });
    return NextResponse.json({ q, images: [], basement_unlocked: true });
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
    const basementUnlocked = await readBasementCookie();
    const matches = await searchByVector(vec, { limit, kind: 'caption' });
    const rows = await getImagesByIdsOrdered(matches.map((m) => m.imageId));
    const allHydrated = await hydrateImages(rows);
    // Strip basement images unless the visitor has the unlock cookie. The
    // primary gate is at the listImages query layer; this covers the
    // embedding search path which bypasses that layer.
    const hydrated = basementUnlocked ? allHydrated : allHydrated.filter((img) => !img.basement);
    return NextResponse.json({ q, images: hydrated });
  } catch (err) {
    // Covers missing embeddings table, pgvector extension not installed,
    // or any downstream DB failure. Match the JSON error shape from the
    // embedder branches above instead of throwing a raw 500.
    console.error('search query failed', err);
    return NextResponse.json({ error: 'search unavailable' }, { status: 503 });
  }
}
