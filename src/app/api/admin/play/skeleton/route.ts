import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { loadGrammar } from '@/lib/db/queries/grammar';
import { generateSkeleton, parseFreezeParam } from '@/lib/playground/skeleton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_N = 24;

export async function GET(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session) || !session?.user?.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const ownerId = session.user.id;

  const url = new URL(req.url);
  const nRaw = Number(url.searchParams.get('n') ?? '6');
  const n = Number.isFinite(nRaw) ? Math.max(1, Math.min(MAX_N, Math.trunc(nRaw))) : 6;
  const freeze = parseFreezeParam(url.searchParams.get('freeze'));

  const { slots, fillersBySlot } = await loadGrammar(ownerId);
  if (slots.length === 0) {
    return NextResponse.json(
      {
        prompts: [],
        warning:
          'no grammar artifact for this owner -- run `bun scripts/derive-grammar.ts` to mine one.'
      },
      { status: 200 }
    );
  }

  const prompts = generateSkeleton({
    slots: slots.map((s) => ({ template: s.template, frequency: s.frequency })),
    fillersBySlot,
    n,
    frozenSlots: freeze
  });

  return NextResponse.json({ prompts });
}
