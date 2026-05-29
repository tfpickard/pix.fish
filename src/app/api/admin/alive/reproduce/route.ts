import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { images } from '@/lib/db/schema';
import { getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';
import { getCaptionVector } from '@/lib/db/queries/embeddings';
import { enqueueJob } from '@/lib/db/queries/jobs';
import {
  archiveImage,
  countActiveImages,
  getLowestFitnessActive,
  recordLineage
} from '@/lib/db/queries/alive';
import { getImageGenerator } from '@/lib/ai/imagegen';
import {
  interpolateEmbeddings,
  sampleTagsDir,
  buildChildPrompt,
  mulberry32
} from '@/lib/alive';
import { slugify } from '@/lib/slug';
import { uniquifySlug } from '@/lib/db/queries/slugs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// feat/alive -- admin-triggered reproduction.
//
// Two parents combine into a child: their caption embeddings interpolate to a
// target latent point, their tags blend via a Dirichlet draw, an image
// generator (the Gate-0 stub until the owner wires a real adapter) renders the
// child, and the child is inserted, enqueued for enrichment, and linked to its
// parents in image_lineage. Optionally, a population cap culls the least-fit
// active image (never a parent of this birth) by archiving it -- a reversible
// "death," never a hard delete.
//
// SAFETY: this is the single, deliberate, admin-only birth trigger. There is no
// cron, no queue auto-fire, no self-scheduling. dryRun computes the entire plan
// and writes nothing -- it never calls generate(), never inserts, never
// archives. The route is isSiteAdmin-gated. No em dashes in any generated text
// (the child prompt comes from buildChildPrompt, which enforces this).

const bodySchema = z.object({
  parentAId: z.number().int().positive(),
  parentBId: z.number().int().positive(),
  // Optional ceiling on the active population. When the active count is at or
  // above this after the birth, the least-fit non-parent active image is
  // archived to make room.
  populationCap: z.number().int().positive().optional(),
  // Dirichlet concentration for tag inheritance. 1.0 == uniform mixture prior.
  alpha: z.number().positive().max(100).optional(),
  // Embedding interpolation weight toward parent B (0..1). 0.5 == midpoint.
  t: z.number().min(0).max(1).optional(),
  // Optional seed for a reproducible dry-run preview. Ignored for the RNG path
  // on a real birth unless provided (a real birth is fine being random).
  seed: z.number().int().optional(),
  dryRun: z.boolean().optional()
});

export async function POST(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const userId = session!.user!.id;
  if (!userId) {
    return NextResponse.json({ error: 'session missing user id' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { parentAId, parentBId, populationCap } = parsed.data;
  const alpha = parsed.data.alpha ?? 1.0;
  const t = parsed.data.t ?? 0.5;
  const dryRun = parsed.data.dryRun ?? false;

  if (parentAId === parentBId) {
    return NextResponse.json(
      { error: 'parents must be two distinct images' },
      { status: 400 }
    );
  }

  // a. Load both parents and their embeddings. A parent without a caption
  //    embedding has no latent point to interpolate from, so reject early with
  //    a clear message rather than silently dropping it.
  const parentRows = await getImagesByIdsOrdered([parentAId, parentBId]);
  const parentA = parentRows.find((r) => r.id === parentAId);
  const parentB = parentRows.find((r) => r.id === parentBId);
  if (!parentA || !parentB) {
    return NextResponse.json(
      { error: 'one or both parent images do not exist' },
      { status: 404 }
    );
  }

  const [vecA, vecB] = await Promise.all([
    getCaptionVector(parentAId),
    getCaptionVector(parentBId)
  ]);
  if (!vecA || !vecB) {
    const missing = [!vecA ? parentAId : null, !vecB ? parentBId : null].filter(
      (x): x is number => x != null
    );
    return NextResponse.json(
      {
        error: `parent image(s) lack a caption embedding and cannot reproduce: ${missing.join(', ')}. Run enrichment or backfill-embeddings for them first.`
      },
      { status: 400 }
    );
  }

  // b. Interpolate embeddings -> child target latent point. (Computed for the
  //    record/dry-run; the child's real embedding is written later by the
  //    enrich.image job from its generated caption, mirroring every upload.)
  let childTarget: number[];
  try {
    childTarget = interpolateEmbeddings(vecA, vecB, t);
  } catch (err) {
    console.error('reproduce: embedding interpolation failed', err);
    return NextResponse.json(
      { error: 'parent embeddings are incompatible (dimension mismatch)' },
      { status: 400 }
    );
  }

  // c. Sample child tags via Dirichlet inheritance. Seeded rng when a seed is
  //    supplied so a dry-run preview is reproducible.
  const [hydA, hydB] = await hydrateImages([parentA, parentB]);
  const aTags = hydA.tags.map((t) => t.tag);
  const bTags = hydB.tags.map((t) => t.tag);
  const rng = parsed.data.seed != null ? mulberry32(parsed.data.seed) : Math.random;
  const sampled = sampleTagsDir(aTags, bTags, alpha, rng);
  const childPrompt = buildChildPrompt(sampled.tags);
  const childGeneration = Math.max(parentA.generation, parentB.generation) + 1;

  // Compute the cull plan up front so both the dry-run preview and the real
  // path use identical logic. The plan is "what would be archived if we
  // enforce the cap after this birth." A parent of this birth is never a valid
  // victim (explicit guard below).
  const cullPlan = await planCull({
    populationCap,
    parentAId,
    parentBId,
    // The birth adds one active image, so compare the post-birth count.
    bornActive: 1
  });

  // d-g. DRY RUN: report the full plan and write nothing. Never calls
  //       generate(), never inserts, never archives.
  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      child: {
        // No id/slug/blobUrl yet -- nothing was created.
        generation: childGeneration,
        prompt: childPrompt,
        tags: sampled.tags,
        dirichletWeights: sampled.weights,
        embeddingDims: childTarget.length
      },
      wouldArchive: cullPlan.victim
        ? { id: cullPlan.victim.imageId, slug: cullPlan.victim.slug }
        : undefined,
      cap:
        populationCap != null
          ? { populationCap, activeBefore: cullPlan.activeBefore }
          : undefined
    });
  }

  // --- Real birth from here. Order mirrors the upload route: blob first (so a
  // later failure leaves no orphaned row), then insert, then enqueue. ---------

  let generated;
  try {
    generated = await getImageGenerator().generate({ prompt: childPrompt, seed: parsed.data.seed });
  } catch (err) {
    console.error('reproduce: image generation failed', err);
    return NextResponse.json({ error: 'image generation failed' }, { status: 502 });
  }

  let blob;
  try {
    blob = await put(`child-${slugify(childPrompt).slice(0, 32) || 'image'}.png`, generated.bytes, {
      access: 'public',
      addRandomSuffix: true,
      contentType: generated.mime
    });
  } catch (err) {
    console.error('reproduce: blob upload failed', err);
    return NextResponse.json({ error: 'blob upload failed' }, { status: 502 });
  }

  const blobKey = blob.pathname;
  const blobTail = blobKey.slice(-12).replace(/[^a-zA-Z0-9]/g, '') || 'img';
  const placeholderSlug = await uniquifySlug(`img-${blobTail}`, userId);

  let inserted;
  try {
    [inserted] = await db
      .insert(images)
      .values({
        slug: placeholderSlug,
        blobUrl: blob.url,
        blobKey,
        mime: generated.mime,
        // The child belongs to the admin who bred it (same ownership model as
        // any upload by this user).
        ownerId: userId,
        generation: childGeneration
      })
      .returning({ id: images.id, slug: images.slug });
  } catch (err) {
    console.error('reproduce: child insert failed', err);
    return NextResponse.json({ error: 'failed to persist child image' }, { status: 500 });
  }
  if (!inserted) {
    return NextResponse.json({ error: 'failed to persist child image' }, { status: 500 });
  }
  const childId = inserted.id;

  // f. Record lineage edges (child -> each parent). Best effort: a failure
  //    here must not undo a successfully created child, but we surface it.
  try {
    await recordLineage(childId, parentAId, parentBId, childPrompt);
  } catch (err) {
    console.error('reproduce: recordLineage failed for child', childId, err);
  }

  // e. Enqueue enrichment so the child gets real captions/descriptions/tags +
  //    a caption embedding exactly like any other upload.
  try {
    await enqueueJob({
      type: 'enrich.image',
      payload: { imageId: childId, ownerId: userId, placeholderSlug }
    });
  } catch (err) {
    console.error('reproduce: failed to enqueue enrich.image for child', childId, err);
  }

  // g. Population-cap enforcement. Re-derive the cull victim now that the child
  //    exists (so the active count and the parent-guard reflect reality), then
  //    archive it. The guard in planCull guarantees we never archive a parent
  //    of this child; we re-assert it here as defense in depth.
  let archived: { id: number; slug: string } | undefined;
  if (populationCap != null) {
    const plan = await planCull({ populationCap, parentAId, parentBId, bornActive: 0 });
    if (plan.victim) {
      if (plan.victim.imageId === parentAId || plan.victim.imageId === parentBId) {
        // Should be impossible (planCull excludes parents). Refuse rather than
        // archive a parent.
        console.error('reproduce: cull victim was a parent; refusing to archive', plan.victim);
      } else if (plan.victim.imageId === childId) {
        // Never archive the just-born child.
        console.error('reproduce: cull victim was the newborn; refusing to archive');
      } else {
        const result = await archiveImage(plan.victim.imageId);
        if (result) archived = { id: result.imageId, slug: result.slug };
      }
    }
  }

  return NextResponse.json({
    dryRun: false,
    child: {
      id: childId,
      slug: inserted.slug,
      blobUrl: blob.url,
      generation: childGeneration,
      prompt: childPrompt,
      tags: sampled.tags,
      dirichletWeights: sampled.weights,
      provider: generated.provider,
      model: generated.model
    },
    archived
  });
}

// planCull(): decide which (if any) active image to archive to honor the cap.
//
// Returns the lowest-fitness active image that is NOT a parent of this birth,
// when the post-birth active count is at or above the cap. The parent-guard is
// the core safety rail: a population cap must never archive an image that just
// produced offspring. We walk the worst-fitness-first list and skip any parent,
// returning the first eligible victim.
async function planCull(args: {
  populationCap?: number;
  parentAId: number;
  parentBId: number;
  bornActive: number;
}): Promise<{
  victim: { imageId: number; slug: string } | null;
  activeBefore: number;
}> {
  const { populationCap, parentAId, parentBId, bornActive } = args;
  const activeBefore = await countActiveImages();
  if (populationCap == null) return { victim: null, activeBefore };

  // The active count after this birth lands. (bornActive is 1 in the dry-run
  // preview, where the child has not been inserted; 0 on the real path, where
  // the insert already happened and is counted by countActiveImages.)
  const activeAfter = activeBefore + bornActive;
  if (activeAfter < populationCap) return { victim: null, activeBefore };

  // Worst-fitness-first, with parents excluded. Pull a margin so that even if
  // the very worst rows are parents we still find a valid victim.
  const candidates = await getLowestFitnessActive(20);
  const victim = candidates.find(
    (c) => c.imageId !== parentAId && c.imageId !== parentBId
  );
  return {
    victim: victim ? { imageId: victim.imageId, slug: victim.slug } : null,
    activeBefore
  };
}
