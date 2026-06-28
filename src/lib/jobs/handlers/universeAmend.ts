import { getEmbedder, getProvider, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { firstCaptionsByImageIds } from '@/lib/db/queries/captions';
import { listClerks } from '@/lib/db/queries/clerks';
import { getDistrict } from '@/lib/db/queries/districts';
import { getNeighborsByImageId } from '@/lib/db/queries/embeddings';
import { appendEvent } from '@/lib/db/queries/events';
import { isImageArchived } from '@/lib/db/queries/images';
import { enqueueJob } from '@/lib/db/queries/jobs';
import { listLoreFragments } from '@/lib/db/queries/lore-fragments';
import { getSpecimen } from '@/lib/db/queries/specimens';
import { getSiteAdminId } from '@/lib/db/queries/users';
import type { Job } from '@/lib/db/schema';
import { buildAmendmentPrompt } from '@/lib/universe/dossier';
import {
  EVENT_TYPE,
  SUBJECT_TYPE,
  dedupeKey,
  type AuditFlaggedPayload,
  type Citation,
  type DossierAmendmentPayload
} from '@/lib/universe/events';
import { materializeSpecimen } from '@/lib/universe/materialize';

type Payload = { imageId: number; seed?: number; depth?: number };

// One step of the evolution loop: a clerk revisits an existing specimen and
// files an amendment -- a new dossier fragment that engages with, and often
// contradicts, the prior readings. The amendment is appended to the canon
// (never overwriting), co-embedded, and materialized into the projections. A
// contradiction against another clerk also files an audit.flagged chronicle
// entry. Finally it enqueues a bounded ripple to neighbouring specimens.
export async function universeAmendHandler(job: Job): Promise<void> {
  const { imageId, seed = imageId, depth = 0 } = job.payload as Payload;

  const specimen = await getSpecimen(imageId);
  if (!specimen) return; // not filed yet (bootstrap hasn't reached it); nothing to amend

  // Skip records pulled from circulation. Covers the ripple path too, which
  // enqueues neighbours directly without the tick's archived filter.
  if (await isImageArchived(imageId)) return;

  const clerks = await listClerks();
  if (clerks.length === 0) return; // no roster commissioned
  const clerkName = new Map(clerks.map((c) => [c.slug, c.name]));

  const fragments = await listLoreFragments(imageId);
  const priorAuthors = new Set(fragments.map((f) => f.clerkSlug));

  // Pick an amending clerk deterministically (seed + imageId). Prefer a clerk
  // who has not yet authored this specimen so a new voice enters; otherwise any
  // clerk other than the current author, so the file keeps moving.
  const fresh = clerks.filter((c) => !priorAuthors.has(c.slug));
  const pool =
    fresh.length > 0 ? fresh : clerks.filter((c) => c.slug !== specimen.clerkSlug);
  const candidates = pool.length > 0 ? pool : clerks;
  const amender = candidates[Math.abs(seed + imageId) % candidates.length]!;

  const district = (await getDistrict(specimen.districtKey)) ?? {
    name: specimen.districtKey,
    character: ''
  };

  // Neighbour RAG: nearest specimens' captions + their current dossiers.
  const near = await getNeighborsByImageId(imageId, { limit: 5, kind: 'caption', order: 'nearest' }).catch(
    () => []
  );
  const neighborIds = near.map((n) => n.imageId);
  const snippets = await firstCaptionsByImageIds(neighborIds);
  const neighbors = await Promise.all(
    neighborIds.map(async (id) => {
      const snip = snippets.get(id);
      const neighborSpecimen = await getSpecimen(id).catch(() => null);
      return {
        slug: snip?.slug ?? String(id),
        caption: snip?.caption ?? '',
        dossier: neighborSpecimen?.currentDossier ?? null
      };
    })
  );

  // AI: the institution writes with the site admin's keys.
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(getSiteAdminId());
  const provider = getProvider('captions', cfg, keys);
  if (!provider || !provider.text) {
    throw new Error('universe.amend: no text-capable provider available');
  }
  const embedder = getEmbedder(cfg, keys);

  const ownCaption = (await firstCaptionsByImageIds([imageId])).get(imageId)?.caption ?? '';
  const prompt = await buildAmendmentPrompt({
    clerk: { name: amender.name, department: amender.department, voice: amender.voice, agenda: amender.agenda },
    captions: ownCaption ? [ownCaption] : [],
    neighbors,
    district: { name: district.name, character: district.character },
    crossReferences: [],
    existingDossier: specimen.currentDossier,
    priorFragments: fragments.map((f) => ({ clerk: clerkName.get(f.clerkSlug) ?? f.clerkSlug, body: f.body }))
  });

  const dossier = (await provider.text(prompt)).trim();
  if (!dossier) throw new Error('universe.amend: empty amendment');

  let embedding: number[] | null = null;
  let embedProvider: string | null = null;
  let embedModel: string | null = null;
  if (embedder) {
    embedding = await embedder.embed(dossier);
    embedProvider = embedder.name;
    embedModel = embedder.model;
  }

  // The amend job's seed is a stable per-job nonce: all attempts of THIS job
  // share it (so retries collapse to one canon event), while a different tick
  // (different seed) produces a distinct amendment. Generation is left to the
  // projection, derived by replay -- never baked into the dedupe key.
  const nonce = seed;
  const payload: DossierAmendmentPayload = {
    dossier,
    districtKey: specimen.districtKey,
    embedding,
    embedProvider,
    embedModel
  };
  const citations: Citation[] = [
    { kind: 'dossier', ref: String(imageId), note: `amends generation ${specimen.generation}` },
    ...neighbors.map((n) => ({ kind: 'neighbor' as const, ref: n.slug }))
  ];

  const { inserted } = await appendEvent({
    type: EVENT_TYPE.DossierAmendment,
    subjectType: SUBJECT_TYPE.Specimen,
    subjectId: String(imageId),
    authorClerk: amender.slug,
    payload,
    citations,
    dedupeKey: dedupeKey.amendment(imageId, nonce)
  });

  // Rebuild this specimen's projection by replaying its full event stream.
  // Idempotent and order-correct, so a retry, a race with another amend, or
  // re-running over an already-materialized event all converge -- no generation
  // drift. Runs whether or not we were the inserter, so a partial earlier
  // failure (event filed, projection not yet built) is recovered.
  await materializeSpecimen(imageId);

  // If this amendment contradicts a prior clerk, file an audit flag for the
  // chronicle. Dedupe-keyed on the same nonce, so it is safe to (re)attempt on
  // a retry. It is a pure event-log artifact (the reducer ignores it); the
  // contradiction itself lives, unreconciled, in the fragments.
  const contradicted = fragments.map((f) => f.clerkSlug).find((s) => s !== amender.slug) ?? null;
  if (contradicted) {
    const audit: AuditFlaggedPayload = {
      note: `${amender.name} files against ${clerkName.get(contradicted) ?? contradicted}'s reading`,
      by: amender.slug,
      contradicts: contradicted
    };
    await appendEvent({
      type: EVENT_TYPE.AuditFlagged,
      subjectType: SUBJECT_TYPE.Specimen,
      subjectId: String(imageId),
      authorClerk: amender.slug,
      payload: audit as unknown as Record<string, unknown>,
      dedupeKey: dedupeKey.audit(imageId, nonce)
    });
  }

  // Event-driven ripple, bounded to one hop. Gated on `inserted` so a retry
  // (event already present) does not re-fan-out to neighbours.
  if (inserted && depth < 1) {
    await enqueueJob({
      type: 'universe.ripple',
      payload: { imageId, seed, depth },
      maxAttempts: 2
    });
  }
}
