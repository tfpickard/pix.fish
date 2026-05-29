import { NextResponse } from 'next/server';
import { auth, canEdit } from '@/lib/auth';
import { getImageBySlug } from '@/lib/db/queries/images';
import { getRemixIdiom } from '@/lib/db/queries/remix-idioms';
import { resolvePrompt } from '@/lib/prompts';
import { parseVariantsJson } from '@/lib/ai/types';
import { getPlaygroundTextRunner } from '@/lib/playground/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Recast an image's concept into a different visual idiom. Owner-only:
// middleware guarantees the request is signed in (path is under
// /api/images/*), and canEdit enforces per-resource ownership here.
export async function POST(req: Request, ctx: { params: { slug: string } }) {
  const session = await auth();

  const img = await getImageBySlug(decodeURIComponent(ctx.params.slug));
  if (!img) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!canEdit(session, img.ownerId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { idiomKey?: unknown } | null;
  const idiomKey = typeof body?.idiomKey === 'string' ? body.idiomKey : '';
  if (!idiomKey) {
    return NextResponse.json({ error: 'idiomKey is required' }, { status: 400 });
  }
  const idiom = await getRemixIdiom(idiomKey);
  if (!idiom || !idiom.active) {
    return NextResponse.json({ error: 'unknown idiom' }, { status: 400 });
  }

  const sourceCaption =
    img.captions.find((c) => c.isSlugSource)?.text ?? img.captions[0]?.text ?? img.slug;

  // Use the image owner's keys, not the viewer's -- the prompt is about their
  // image and a site admin remixing another user's image should still bill the
  // owner's provider routing (matching how enrichment runs under ownerId).
  const runner = await getPlaygroundTextRunner(img.ownerId);
  if (!runner) {
    return NextResponse.json(
      { prompts: [], warning: 'no text provider configured for this image owner.' },
      { status: 200 }
    );
  }

  const prompt = await resolvePrompt('remix', {
    source_caption: sourceCaption,
    idiom_label: idiom.label,
    idiom_description: idiom.description
  });

  let raw: string;
  try {
    raw = await runner.run(prompt);
  } catch (err) {
    console.error('remix generation failed', err);
    return NextResponse.json({ error: 'generation failed' }, { status: 502 });
  }

  const prompts = parseVariantsJson(raw).filter(Boolean);
  return NextResponse.json({ prompts, idiom: { key: idiom.key, label: idiom.label } });
}
