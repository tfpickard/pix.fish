import { NextResponse } from 'next/server';
import { readNsfwMode } from '@/lib/nsfw';
import { searchByVector } from '@/lib/db/queries/embeddings';
import { getCaptionVectorsForIds } from '@/lib/db/queries/taste';
import { hydrateNodes } from '@/lib/db/queries/daily';
import { tasteVector } from '@/lib/taste/vector';
import type { PathNode } from '@/lib/knn-path-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type NextPair = { a: PathNode; b: PathNode } | { pair: null };

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 60);
}

// Adaptive next-pair for the taste quiz: given the picks so far, draw two unseen
// images from the visitor's current taste neighbourhood -- both plausibly "you",
// so the choice is a real preference that sharpens the vector rather than an
// obvious gimme. The client falls back to a pre-seeded random pair if this is
// slow or unavailable, so play never blocks on it.
export async function GET(req: Request): Promise<NextResponse<NextPair>> {
  try {
    const { searchParams } = new URL(req.url);
    const picked = parseIds(searchParams.get('p'));
    const skipped = parseIds(searchParams.get('s'));
    const seen = new Set([...parseIds(searchParams.get('seen')), ...picked, ...skipped]);
    if (picked.length === 0) return NextResponse.json({ pair: null });

    const nsfwMode = await readNsfwMode();
    const vecs = await getCaptionVectorsForIds([...new Set([...picked, ...skipped])]);
    const pv = picked.map((id) => vecs.get(id)).filter((v): v is number[] => !!v);
    const sv = skipped.map((id) => vecs.get(id)).filter((v): v is number[] => !!v);
    const taste = tasteVector(pv, sv);
    if (!taste) return NextResponse.json({ pair: null });

    const ranked = await searchByVector(taste, { limit: 40, kind: 'caption', nsfwMode, order: 'nearest' });
    const pool = ranked.map((m) => m.imageId).filter((id) => !seen.has(id));
    // Skip the few most-obvious matches so the round is a genuine choice between
    // two appealing images, not a gimme.
    const band = pool.length >= 4 ? pool.slice(2) : pool;
    const aId = band[0];
    const bId = band[1];
    if (!aId || !bId) return NextResponse.json({ pair: null });

    const meta = await hydrateNodes([aId, bId]);
    const a = meta.get(aId);
    const b = meta.get(bId);
    if (!a || !b || !a.blobUrl || !b.blobUrl) return NextResponse.json({ pair: null });
    return NextResponse.json({ a, b });
  } catch (err) {
    console.error('/api/taste/next failed', err);
    return NextResponse.json({ pair: null });
  }
}
