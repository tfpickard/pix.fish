import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import {
  CARD_CATEGORIES,
  CARDS_PER_CATEGORY_PER_LOAD,
  isCardCategory,
  listCardsSampled,
  type CardCategory
} from '@/lib/db/queries/constraint-cards';
import { rollDice, rollDicePerCategory } from '@/lib/playground/dice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_N = 24;

export async function GET(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const url = new URL(req.url);
  const nRaw = Number(url.searchParams.get('n') ?? '3');
  const n = Number.isFinite(nRaw) ? Math.max(1, Math.min(MAX_N, Math.trunc(nRaw))) : 3;
  const perCategory = url.searchParams.get('perCategory') === '1';

  const requested = url.searchParams.getAll('category').filter((c) => c.length > 0);
  // Invalid categories silently dropped; if every requested one is invalid
  // we still pull from the full pool rather than 400'ing on the request --
  // the dice section is best-effort and never blocking.
  const categories: CardCategory[] = requested.filter(isCardCategory) as CardCategory[];

  // Sample a per-category slice of the pool so the response stays small even
  // when the constraint_cards table grows to hundreds per category. The
  // client-side Fisher-Yates roll (rollDice/rollDicePerCategory) picks n=3
  // from this slice, so CARDS_PER_CATEGORY_PER_LOAD >> 3 gives plenty of
  // variety without shipping the full pool.
  const pool = await listCardsSampled({
    categories: categories.length > 0 ? categories : undefined,
    perCategory: CARDS_PER_CATEGORY_PER_LOAD
  });
  if (pool.length === 0) {
    return NextResponse.json({ rolls: [], warning: 'no active constraint cards' });
  }

  const rolls = perCategory
    ? rollDicePerCategory({ pool, perCategory: n })
    : rollDice({ pool, n });

  return NextResponse.json({ rolls, categories: CARD_CATEGORIES });
}
