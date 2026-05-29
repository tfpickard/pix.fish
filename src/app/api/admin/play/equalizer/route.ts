import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { loadGrammar } from '@/lib/db/queries/grammar';
import { listVibeAxes } from '@/lib/db/queries/vibe-axes';
import { resolvePrompt } from '@/lib/prompts';
import { parseVariantsJson } from '@/lib/ai/types';
import { getPlaygroundTextRunner, formatGrammarStyle } from '@/lib/playground/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Render a 0..1 slider value as a coarse, human-readable level. The model
// reads the words; the number is along for traceability.
function levelFor(v: number): string {
  if (v <= 0.15) return 'far toward';
  if (v <= 0.4) return 'toward';
  if (v < 0.6) return 'balanced between';
  if (v < 0.85) return 'toward';
  return 'far toward';
}

export async function GET(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session) || !session?.user?.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const ownerId = session.user.id;

  const axes = await listVibeAxes();
  if (axes.length === 0) {
    return NextResponse.json(
      {
        prompts: [],
        axes: [],
        warning:
          'no vibe axes defined -- run `bun scripts/vibe-axes.ts` to compare approaches, then `--write <approach>` to persist them.'
      },
      { status: 200 }
    );
  }

  const url = new URL(req.url);
  // Build the {{axis_targets}} block: each axis gets its slider value (default
  // 0.5) translated into a pole-relative instruction.
  const targetLines = axes.map((axis) => {
    const raw = Number(url.searchParams.get(axis.key));
    const v = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5;
    const pole = v < 0.5 ? axis.negativePole : axis.positivePole;
    const where = v >= 0.4 && v < 0.6 ? `balanced between ${axis.negativePole} and ${axis.positivePole}` : `${levelFor(v)} ${pole}`;
    return `  - ${axis.label}: ${where} (${v.toFixed(2)})`;
  });

  const { slots, fillersBySlot } = await loadGrammar(ownerId);
  const grammarStyle = formatGrammarStyle(slots, fillersBySlot);

  const runner = await getPlaygroundTextRunner();
  if (!runner) {
    return NextResponse.json(
      { prompts: [], axes, warning: 'no text provider configured for the site admin.' },
      { status: 200 }
    );
  }

  const prompt = await resolvePrompt('equalizer', {
    axis_targets: targetLines.join('\n'),
    grammar_style: grammarStyle
  });

  let raw: string;
  try {
    raw = await runner.run(prompt);
  } catch (err) {
    console.error('equalizer generation failed', err);
    return NextResponse.json({ error: 'generation failed' }, { status: 502 });
  }

  const prompts = parseVariantsJson(raw).filter(Boolean);
  return NextResponse.json({ prompts, axes });
}
