import { put } from '@vercel/blob';
import type { Job } from '@/lib/db/schema';
import { hydrateNodes } from '@/lib/db/queries/daily';
import { updateJobPayload } from '@/lib/db/queries/jobs';
import { compositePrompt, COMPOSITE_PROMPT_MODEL } from '@/lib/fuse/composite-prompt';
import { getImageGenerator } from '@/lib/ai/imagegen';

// Background render of a /fuse pairing via OpenAI's image-2 model. Enqueued by
// the admin-gated POST /api/fuse/render so the (slow, paid) generation runs off
// the request path -- the admin's request returns a job id immediately and the
// client polls for the result. Reusing the job queue means the work survives the
// admin navigating away and isn't bound to a single HTTP request's lifetime.
//
// The pairing was already validated (active + embedded + visible) at enqueue
// time. This handler rebuilds the composite prompt server-side from the parents'
// captions, generates with gpt-image-2, uploads to Vercel Blob, and stashes the
// result URL on the job payload for the poll endpoint to return.
//
// IMPORTANT: enqueue this with maxAttempts: 1. Each attempt is a paid generation,
// so a timed-out/failed render must NOT silently retry and re-bill.

type FuseRenderPayload = { a?: unknown; b?: unknown };

export async function fuseRenderHandler(job: Job): Promise<void> {
  const p = (job.payload ?? {}) as FuseRenderPayload;
  const a = Number(p.a);
  const b = Number(p.b);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) {
    throw new Error('fuse.render: invalid payload');
  }

  const meta = await hydrateNodes([a, b]);
  const na = meta.get(a);
  const nb = meta.get(b);
  if (!na || !nb) throw new Error('fuse.render: parent image(s) not found');
  const prompt = compositePrompt(na.caption, nb.caption);

  // Explicitly the image-2 model the prompt is written for.
  const generator = getImageGenerator({ provider: 'openai', model: COMPOSITE_PROMPT_MODEL });
  if (generator.name === 'stub') {
    throw new Error('fuse.render: image generation is not configured (set OPENAI_API_KEY)');
  }

  // Abort the (paid) generation a hair under the worker's 55s per-job cap so the
  // in-flight fetch is cancelled deterministically instead of being left dangling
  // when the function is killed at the 60s wall. maxAttempts: 1 makes this failure
  // terminal -- no silent retry/re-bill.
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), 50_000);
  let generated;
  try {
    generated = await generator.generate({
      prompt,
      width: 1024,
      height: 1024,
      signal: controller.signal
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('fuse.render: generation exceeded the 50s budget and was aborted');
    }
    throw err;
  } finally {
    clearTimeout(budget);
  }

  const blob = await put(`fuse-renders/${a}-${b}.png`, generated.bytes, {
    access: 'public',
    addRandomSuffix: true,
    contentType: generated.mime
  });

  // Stash the result on the job so the poll endpoint can hand it back. The worker
  // marks the job done once this returns.
  await updateJobPayload(job.id, { a, b, url: blob.url, prompt, model: generated.model });
}
