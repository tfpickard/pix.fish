/**
 * Universe Phase 1 bootstrap. Files an intake dossier for every image into the
 * append-only canon, materializes the projections, and co-embeds each dossier
 * in the same vector space as the captions.
 *
 * Idempotent: every event is guarded by a stable dedupe_key, so a second run
 * appends nothing and makes zero AI calls. Append-only is never violated.
 *
 * Order:
 *   1. ensure the 'dossier' prompt row exists (does not clobber a tuned one)
 *   2. commission the clerk roster (clerk.commissioned events)
 *   3. file cross-references from the image kNN graph (cross_reference.filed)
 *   4. derive districts from kNN-graph communities + synthesize their character
 *      (district.intake events)
 *   5. per image (ascending id): assemble RAG context, generate a clerk dossier,
 *      embed it, append specimen.intake (embedding vector carried in payload)
 *   6. rebuild all projections from the log
 *
 *   bun scripts/universe-bootstrap.ts
 */
import { asc, eq, sql } from 'drizzle-orm';
import { getEmbedder, getProvider, loadUserProviderKeys } from '../src/lib/ai';
import { loadAiConfig } from '../src/lib/ai/loadConfig';
import { db } from '../src/lib/db/client';
import { captions, images, prompts } from '../src/lib/db/schema';
import { allCaptionVectors, getNeighborsByImageId } from '../src/lib/db/queries/embeddings';
import { appendEvent, eventExists } from '../src/lib/db/queries/events';
import { getEdgesForNode, listAllImageEdges } from '../src/lib/db/queries/knn';
import { getSiteAdminId } from '../src/lib/db/queries/users';
import { detectCommunities } from '../src/lib/universe/cluster';
import { buildDistrictPrompt, parseDistrictIdentity } from '../src/lib/universe/district';
import { buildDossierPrompt, DEFAULT_DOSSIER_TEMPLATE } from '../src/lib/universe/dossier';
import {
  EVENT_TYPE,
  SUBJECT_TYPE,
  dedupeKey,
  type Citation
} from '../src/lib/universe/events';
import { rebuildProjections } from '../src/lib/universe/materialize';
import { CLERK_ROSTER } from '../src/lib/universe/roster';

async function main() {
  // --- AI providers (the institution writes with the site admin's keys) -----
  const adminId = getSiteAdminId();
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(adminId);
  const provider = getProvider('captions', cfg, keys);
  if (!provider || !provider.text) {
    console.error('no text-capable provider available (need ANTHROPIC/OPENAI key). aborting.');
    process.exit(1);
  }
  const embedder = getEmbedder(cfg, keys);
  if (!embedder) {
    console.error('no embedder available (need an embeddings key). dossiers would not be searchable. aborting.');
    process.exit(1);
  }

  // --- 1. ensure the dossier prompt exists (do not overwrite a tuned one) ---
  await db
    .insert(prompts)
    .values({ key: 'dossier', template: DEFAULT_DOSSIER_TEMPLATE })
    .onConflictDoNothing({ target: prompts.key });

  // --- load corpus ----------------------------------------------------------
  const imageRows = await db
    .select({ id: images.id, slug: images.slug })
    .from(images)
    .orderBy(asc(images.id));
  const slugById = new Map(imageRows.map((r) => [r.id, r.slug]));

  // Captions grouped per image (slug-source first).
  const capRows = await db
    .select({ imageId: captions.imageId, text: captions.text, isSlugSource: captions.isSlugSource, variant: captions.variant })
    .from(captions)
    .orderBy(asc(captions.imageId), sql`${captions.isSlugSource} DESC`, asc(captions.variant));
  const captionsById = new Map<number, string[]>();
  for (const c of capRows) {
    const list = captionsById.get(c.imageId) ?? [];
    list.push(c.text);
    captionsById.set(c.imageId, list);
  }

  console.log(`corpus: ${imageRows.length} images`);

  // --- 2. commission clerks -------------------------------------------------
  for (const clerk of CLERK_ROSTER) {
    const res = await appendEvent({
      type: EVENT_TYPE.ClerkCommissioned,
      subjectType: SUBJECT_TYPE.Clerk,
      subjectId: clerk.slug,
      authorClerk: null,
      payload: {
        name: clerk.name,
        department: clerk.department,
        voice: clerk.voice,
        agenda: clerk.agenda
      },
      dedupeKey: dedupeKey.clerk(clerk.slug)
    });
    if (res.inserted) console.log(`  commissioned ${clerk.slug}`);
  }

  // --- 3. cross-references from the kNN graph -------------------------------
  const edges = await listAllImageEdges();
  let xrefFiled = 0;
  for (const e of edges) {
    const res = await appendEvent({
      type: EVENT_TYPE.CrossReferenceFiled,
      subjectType: SUBJECT_TYPE.CrossReference,
      subjectId: `${e.src}:${e.dst}`,
      authorClerk: null,
      payload: { srcImageId: e.src, dstImageId: e.dst, dist: e.dist },
      dedupeKey: dedupeKey.crossReference(e.src, e.dst)
    });
    if (res.inserted) xrefFiled++;
  }
  console.log(`  cross-references: ${edges.length} edges (${xrefFiled} newly filed)`);

  // --- 4. districts from kNN-graph communities ------------------------------
  const nodeIds = (await allCaptionVectors()).map((v) => v.imageId);
  const communities = detectCommunities(nodeIds, edges);
  console.log(`  communities: ${communities.length} districts from ${nodeIds.length} graph nodes`);

  // imageId -> districtKey, plus an identity map for RAG context.
  const districtByImage = new Map<number, string>();
  const districtIdentity = new Map<string, { name: string; character: string }>();
  for (const community of communities) {
    for (const id of community.memberImageIds) districtByImage.set(id, community.key);

    // Synthesize the district's name + character from its members' captions.
    const memberCaptions = community.memberImageIds.flatMap((id) => captionsById.get(id) ?? []);
    let identity = { name: `District ${community.key.replace('district-', '')}`, character: '' };
    try {
      const raw = await provider.text!(buildDistrictPrompt(memberCaptions));
      identity = parseDistrictIdentity(raw, community.key);
    } catch (err) {
      console.error(`  district ${community.key} synthesis failed, using fallback`, err);
      identity = parseDistrictIdentity('', community.key);
    }
    districtIdentity.set(community.key, identity);

    await appendEvent({
      type: EVENT_TYPE.DistrictIntake,
      subjectType: SUBJECT_TYPE.District,
      subjectId: community.key,
      authorClerk: null,
      payload: {
        name: identity.name,
        character: identity.character,
        memberImageIds: community.memberImageIds,
        size: community.memberImageIds.length
      },
      dedupeKey: dedupeKey.district(community.key)
    });
    console.log(`  district ${community.key}: "${identity.name}" (${community.memberImageIds.length} members)`);
  }

  // Fallback district for any image not in the graph (no caption embedding).
  const UNFILED = 'district-unfiled';
  const needUnfiled = imageRows.some((r) => !districtByImage.has(r.id));
  if (needUnfiled) {
    const identity = {
      name: 'The Unfiled Backlog',
      character:
        'Records the machinery could not place. They sit in a holding wing, awaiting a classification that may never come.'
    };
    districtIdentity.set(UNFILED, identity);
    await appendEvent({
      type: EVENT_TYPE.DistrictIntake,
      subjectType: SUBJECT_TYPE.District,
      subjectId: UNFILED,
      authorClerk: null,
      payload: { name: identity.name, character: identity.character, memberImageIds: [], size: 0 },
      dedupeKey: dedupeKey.district(UNFILED)
    });
  }

  // --- 5. per-image dossiers ------------------------------------------------
  // Dossiers generated this run, so a later image can cite an earlier one.
  const dossierByImage = new Map<number, string>();
  let filed = 0;
  let skipped = 0;
  let failed = 0;

  for (const img of imageRows) {
    const guard = dedupeKey.specimenIntake(img.id);
    // Cheap pre-check avoids an AI call when the dossier is already on file.
    if (await eventExists(guard)) {
      skipped++;
      continue;
    }

    const clerk = CLERK_ROSTER[img.id % CLERK_ROSTER.length]!;
    const districtKey = districtByImage.get(img.id) ?? UNFILED;
    const district = districtIdentity.get(districtKey) ?? {
      name: districtKey,
      character: ''
    };
    const imgCaptions = captionsById.get(img.id) ?? [];

    // Neighbours (RAG): nearest caption-embedding neighbours, their captions
    // and any dossier already filed this run.
    const near = await getNeighborsByImageId(img.id, { limit: 5, kind: 'caption', order: 'nearest' }).catch(() => []);
    const neighbors = near.map((n) => ({
      slug: slugById.get(n.imageId) ?? String(n.imageId),
      caption: (captionsById.get(n.imageId) ?? [])[0] ?? '',
      dossier: dossierByImage.get(n.imageId) ?? null
    }));

    // Directed cross-references already established for this specimen.
    const outEdges = await getEdgesForNode(img.id).catch(() => []);
    const crossReferences = outEdges
      .slice()
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 6)
      .map((e) => ({ slug: slugById.get(e.dstId) ?? String(e.dstId), dist: e.dist }));

    try {
      const prompt = await buildDossierPrompt({
        clerk: { name: clerk.name, department: clerk.department, voice: clerk.voice, agenda: clerk.agenda },
        captions: imgCaptions,
        neighbors,
        district: { name: district.name, character: district.character },
        crossReferences
      });
      const dossier = (await provider.text!(prompt)).trim();
      if (!dossier) throw new Error('empty dossier');

      const embedding = await embedder.embed(dossier);

      const citations: Citation[] = [
        { kind: 'district', ref: districtKey, note: district.name },
        ...neighbors.map((n) => ({ kind: 'neighbor' as const, ref: n.slug })),
        ...(imgCaptions.length > 0 ? [{ kind: 'caption' as const, ref: img.slug, note: `${imgCaptions.length} caption(s) on record` }] : [])
      ];

      await appendEvent({
        type: EVENT_TYPE.SpecimenIntake,
        subjectType: SUBJECT_TYPE.Specimen,
        subjectId: String(img.id),
        authorClerk: clerk.slug,
        payload: {
          dossier,
          districtKey,
          embedding,
          embedProvider: embedder.name,
          embedModel: embedder.model
        },
        citations,
        dedupeKey: guard
      });
      dossierByImage.set(img.id, dossier);
      filed++;
      console.log(`  [${img.id}] ${img.slug} -- filed by ${clerk.slug} (${districtKey})`);
    } catch (err) {
      failed++;
      console.error(`  [${img.id}] ${img.slug} -- FAILED:`, err);
    }
  }

  console.log(`intake: ${filed} filed, ${skipped} already on file, ${failed} failed`);

  // --- 6. materialize projections from the log ------------------------------
  const { events } = await rebuildProjections();
  console.log(`projections rebuilt from ${events} events`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
