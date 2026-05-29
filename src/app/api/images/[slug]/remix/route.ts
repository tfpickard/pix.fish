import { NextResponse } from 'next/server';
import { auth, canEdit } from '@/lib/auth';
import { getImageBySlug, getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';
import type { ImageWithRelations } from '@/lib/db/queries/images';
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

  const body = (await req.json().catch(() => null)) as
    | { idiomKey?: unknown; imageId?: unknown }
    | null;

  // Resolve by image id when the caller provides it. Slugs are unique only
  // per owner, and getImageBySlug prefers the site admin's row on a collision,
  // so a slug-only lookup can return the wrong image: a non-admin owner would
  // 403 on their own image, and an admin could remix from the wrong caption.
  // The detail page always has the id, so prefer it; fall back to slug for the
  // legacy bare-slug path.
  let img: ImageWithRelations | null = null;
  const imageId =
    typeof body?.imageId === 'number' && Number.isInteger(body.imageId) ? body.imageId : null;
  if (imageId !== null) {
    const rows = await getImagesByIdsOrdered([imageId]);
    img = (await hydrateImages(rows))[0] ?? null;
  } else {
    img = await getImageBySlug(decodeURIComponent(ctx.params.slug));
  }
  if (!img) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!canEdit(session, img.ownerId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

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
