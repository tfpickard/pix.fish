import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { auth, isSiteAdmin } from '@/lib/auth';
import { readNsfwMode } from '@/lib/nsfw';
import { activeFuseIds } from '@/lib/db/queries/fuse';
import { hydrateNodes } from '@/lib/db/queries/daily';
import { compositePrompt, COMPOSITE_PROMPT_MODEL } from '@/lib/fuse/composite-prompt';
import { getImageGenerator } from '@/lib/ai/imagegen';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Image generation is slow; give it room under the Vercel function ceiling.
export const maxDuration = 60;

// Live render of a /fuse pairing via OpenAI's image-2 model. ADMIN-ONLY: only
// the owner can spend on (paid) generation. The /fuse "render for real" button
// is hidden for everyone else, but THIS gate (isSiteAdmin) is the real one --
// a non-admin can't trigger a render even by forging the request.
//
// The composite prompt is built server-side from the two parents' captions
// (never trust a client-supplied prompt), generated with gpt-image-2, and stored
// to Vercel Blob. It deliberately does NOT add a gallery row -- this is a render
// preview of the imagined blend, not a new specimen in the corpus.
export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'sign in required' }, { status: 401 });
  }
  if (!isSiteAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: { a?: unknown; b?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const a = Number(body.a);
  const b = Number(body.b);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) {
    return NextResponse.json({ error: 'two distinct image ids required' }, { status: 400 });
  }

  // Even admin-only, bound accidental rapid-fire (each render is a paid call).
  const ipHash = hashIp(getRequestIp(req));
  if (!rateLimit(`fuserender:${ipHash}`, 20, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const nsfwMode = await readNsfwMode();
  const allowed = await activeFuseIds([a, b], nsfwMode);
  if (!allowed.has(a) || !allowed.has(b)) {
    return NextResponse.json({ error: 'unfusable ids' }, { status: 422 });
  }

  const meta = await hydrateNodes([a, b]);
  const na = meta.get(a);
  const nb = meta.get(b);
  if (!na || !nb) {
    return NextResponse.json({ error: 'unfusable ids' }, { status: 422 });
  }
  const prompt = compositePrompt(na.caption, nb.caption);

  // Explicitly the image-2 model the prompt is written for, independent of the
  // global imagegen config that drives the alive flow.
  const generator = getImageGenerator({ provider: 'openai', model: COMPOSITE_PROMPT_MODEL });
  if (generator.name === 'stub') {
    return NextResponse.json(
      { error: 'image generation is not configured (set OPENAI_API_KEY)' },
      { status: 503 }
    );
  }

  let generated;
  try {
    generated = await generator.generate({ prompt, width: 1024, height: 1024 });
  } catch (err) {
    console.error('fuse render: generation failed', err);
    return NextResponse.json({ error: 'generation failed' }, { status: 502 });
  }

  let blob;
  try {
    blob = await put(`fuse-renders/${a}-${b}.png`, generated.bytes, {
      access: 'public',
      addRandomSuffix: true,
      contentType: generated.mime
    });
  } catch (err) {
    console.error('fuse render: blob upload failed', err);
    return NextResponse.json({ error: 'blob upload failed' }, { status: 502 });
  }

  return NextResponse.json({ url: blob.url, prompt, model: generated.model });
}
