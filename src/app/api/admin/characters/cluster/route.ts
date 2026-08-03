import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getTuning, saveTuning } from '@/lib/db/queries/character-tuning';
import { nextClusterRunStamp } from '@/lib/db/queries/events';
import { enqueueJob } from '@/lib/db/queries/jobs';
import { clusterReadiness } from '@/lib/universe/visual-coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Enqueue the clustering pipeline (cluster -> verify -> census). Any knobs in the
// body are persisted as the new defaults (so the sliders stick) AND passed in the
// job payload for this run. Omitted knobs fall back to the saved tuning. The run
// stamp is set here so a reclaimed/re-run cluster reuses it (collapses through the
// census dedupe key) rather than filing a duplicate census.
const bodySchema = z
  .object({
    maxDist: z.number().min(0.05).max(1).optional(),
    k: z.number().int().min(1).max(30).optional(),
    pruneK: z.number().int().min(1).max(30).optional(),
    minAppearances: z.number().int().min(2).max(50).optional(),
    verifyEnabled: z.boolean().optional(),
    space: z.enum(['text', 'visual', 'blend']).optional(),
    blendWeight: z.number().min(0).max(1).optional(),
    // Deliberate override, not a knob: cluster on the embedded subset even
    // though some crops lack the space's vector. Accepts the consequence the
    // handler's guard exists to prevent -- characters seen only in the skipped
    // crops get pruned from the canon by the resulting census. Never persisted
    // to the tuning, so it applies to this run only and can't leak into the
    // cron's runs.
    partialOk: z.boolean().optional()
  })
  .default({});

export async function POST(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }

  // Persist any provided knobs, then resolve the effective set from storage.
  const { partialOk, ...knobs } = parsed.data;
  if (Object.keys(knobs).length > 0) await saveTuning(knobs);
  const tuning = await getTuning();

  // Refuse a run that would abort in produceCandidates. Reported here rather
  // than as a failed job so the admin sees the blocker (and its remedies) in the
  // response to the click that caused it, instead of having to go read
  // /admin/jobs.
  //
  // partialOk overrides the PARTIAL-coverage guard only. produceCandidates has a
  // second, harder guard -- a nonempty corpus where NO crop has the needed vector
  // -- and that one takes no override, because filing the resulting empty census
  // would wipe the roster rather than merely prune it. Selecting 'visual' before
  // any backfill has run hits exactly that, so partialOk there would enqueue the
  // same doomed job this route exists to refuse. Check it either way.
  const readiness = await clusterReadiness();
  if (readiness.needsVisual && readiness.embedded === 0 && (readiness.retriable || readiness.abandoned)) {
    return NextResponse.json(
      {
        error: 'no usable visual vectors',
        blocker:
          `No crop has a '${readiness.space}' vector yet, so there is nothing to cluster -- ` +
          `partialOk cannot override this. Run the visual backfill first, or switch the identity ` +
          `space back to 'text'.`,
        readiness
      },
      { status: 409 }
    );
  }
  if (!partialOk && !readiness.ready) {
    return NextResponse.json(
      { error: 'visual coverage incomplete', blocker: readiness.blocker, readiness },
      { status: 409 }
    );
  }

  const payload = {
    runStamp: await nextClusterRunStamp(),
    minAppearances: tuning.minAppearances,
    maxDist: tuning.maxDist,
    k: tuning.k,
    pruneK: tuning.pruneK,
    verifyEnabled: tuning.verifyEnabled,
    space: tuning.space,
    blendWeight: tuning.blendWeight,
    ...(partialOk ? { partialOk: true } : {})
  };
  const job = await enqueueJob({ type: 'characters.cluster', payload, maxAttempts: 1 });
  return NextResponse.json({ jobId: job.id, tuning, partialOk: partialOk ?? false });
}
