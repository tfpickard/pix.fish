import type { UniverseEvent } from '@/lib/db/schema';
import { upsertClerk } from '@/lib/db/queries/clerks';
import { upsertCrossReference } from '@/lib/db/queries/cross-references';
import { upsertDistrict } from '@/lib/db/queries/districts';
import { upsertLoreEmbedding } from '@/lib/db/queries/embeddings';
import {
  countAmendmentFragments,
  latestLoreFragment,
  upsertLoreFragment
} from '@/lib/db/queries/lore-fragments';
import { getSpecimen, upsertSpecimen } from '@/lib/db/queries/specimens';
import { coordsFor, type CoordsMap } from './coords';
import {
  deleteAllAppearances,
  deleteAllCharacters,
  insertAppearance,
  upsertCharacter
} from '@/lib/db/queries/characters';
import {
  EVENT_TYPE,
  type CharacterCensusPayload,
  type ClerkCommissionedPayload,
  type CrossReferenceFiledPayload,
  type DistrictIntakePayload,
  type SpecimenIntakePayload
} from './events';

// The reducers. Each maps one event to its projection upserts. Used by both
// the bootstrap (materialize-as-you-go) and the rebuild script (replay the
// whole log). Pure projection writes: no AI calls, no event writes -- so a
// rebuild is fully offline. Embedding vectors come from the event payload.

export type ReduceContext = { coords: CoordsMap };

export async function applyEvent(ev: UniverseEvent, ctx: ReduceContext): Promise<void> {
  switch (ev.type) {
    case EVENT_TYPE.ClerkCommissioned: {
      const p = ev.payload as unknown as ClerkCommissionedPayload;
      await upsertClerk({
        slug: ev.subjectId,
        name: p.name,
        department: p.department,
        voice: p.voice,
        agenda: p.agenda,
        commissionedAt: ev.createdAt
      });
      break;
    }

    case EVENT_TYPE.DistrictIntake: {
      const p = ev.payload as unknown as DistrictIntakePayload;
      await upsertDistrict({
        key: ev.subjectId,
        name: p.name,
        character: p.character,
        size: p.size,
        memberImageIds: p.memberImageIds,
        createdAt: ev.createdAt
      });
      break;
    }

    case EVENT_TYPE.SpecimenIntake: {
      const p = ev.payload as unknown as SpecimenIntakePayload;
      const imageId = Number(ev.subjectId);
      const clerkSlug = ev.authorClerk ?? 'unknown';

      await upsertSpecimen({
        imageId,
        clerkSlug,
        districtKey: p.districtKey,
        currentDossier: p.dossier,
        citations: ev.citations,
        intakeEventId: ev.id,
        generation: 0,
        updatedAt: ev.createdAt
      });

      const c = coordsFor(ctx.coords, imageId);
      const fragmentId = await upsertLoreFragment({
        specimenImageId: imageId,
        eventId: ev.id,
        clerkSlug,
        kind: 'intake',
        body: p.dossier,
        sources: ev.citations,
        x: c.x,
        y: c.y,
        z: c.z,
        createdAt: ev.createdAt
      });

      // Re-populate the fragment's embedding from the canon vector (no API
      // call). subject_type='lore' co-locates it with the images in pgvector.
      if (p.embedding && p.embedProvider && p.embedModel) {
        await upsertLoreEmbedding({
          loreFragmentId: fragmentId,
          kind: 'caption',
          vec: p.embedding,
          provider: p.embedProvider,
          model: p.embedModel
        });
      }
      break;
    }

    case EVENT_TYPE.CrossReferenceFiled: {
      const p = ev.payload as unknown as CrossReferenceFiledPayload;
      await upsertCrossReference({
        srcImageId: p.srcImageId,
        dstImageId: p.dstImageId,
        dist: p.dist,
        kind: 'knn',
        createdAt: ev.createdAt
      });
      break;
    }

    case EVENT_TYPE.DossierAmendment: {
      // A clerk amendment (Phase 2). Append a new fragment, advance the current
      // dossier, and set generation from the COUNT of amendment fragments --
      // not a read-modify-write of generation -- so concurrent or repeated
      // materializations converge instead of drifting above the event count.
      const p = ev.payload as unknown as SpecimenIntakePayload;
      const imageId = Number(ev.subjectId);
      const clerkSlug = ev.authorClerk ?? 'unknown';
      const existing = await getSpecimen(imageId);
      const c = coordsFor(ctx.coords, imageId);

      const fragmentId = await upsertLoreFragment({
        specimenImageId: imageId,
        eventId: ev.id,
        clerkSlug,
        kind: 'amendment',
        body: p.dossier,
        sources: ev.citations,
        x: c.x,
        y: c.y,
        z: c.z,
        createdAt: ev.createdAt
      });
      if (p.embedding && p.embedProvider && p.embedModel) {
        await upsertLoreEmbedding({
          loreFragmentId: fragmentId,
          kind: 'caption',
          vec: p.embedding,
          provider: p.embedProvider,
          model: p.embedModel
        });
      }
      // Derive the specimen's live fields from the NEWEST fragment on file and
      // the amendment COUNT, both read after the upsert above -- never from the
      // event being applied. This makes the projection a convergent fold: two
      // overlapping replays (or a stale snapshot finishing last) land on the
      // same current dossier/clerk/generation instead of rolling back.
      const generation = await countAmendmentFragments(imageId);
      const latest = await latestLoreFragment(imageId);
      await upsertSpecimen({
        imageId,
        clerkSlug: latest?.clerkSlug ?? clerkSlug,
        districtKey: existing?.districtKey ?? p.districtKey,
        currentDossier: latest?.body ?? p.dossier,
        citations: latest?.sources ?? ev.citations,
        intakeEventId: existing?.intakeEventId ?? ev.id,
        generation,
        updatedAt: latest?.createdAt ?? ev.createdAt
      });
      break;
    }

    case EVENT_TYPE.CharacterCensus: {
      // A census defines the entire recurring-character roster. Clear and
      // replace the projection so the newest census wins; on a full rebuild,
      // replaying censuses in order leaves the last one in effect.
      const p = ev.payload as unknown as CharacterCensusPayload;
      await deleteAllAppearances();
      await deleteAllCharacters();
      for (const c of p.characters) {
        await upsertCharacter({
          key: c.key,
          name: c.name,
          dossier: c.dossier,
          clerkSlug: c.clerkSlug,
          canonicalCropUrl: c.canonicalCropUrl ?? null,
          appearanceCount: c.appearances.length,
          censusEventId: ev.id,
          generation: 0,
          createdAt: ev.createdAt
        });
        for (const a of c.appearances) {
          await insertAppearance({
            characterKey: c.key,
            imageId: a.imageId,
            cropUrl: a.cropUrl ?? null,
            box: a.box ?? null,
            createdAt: ev.createdAt
          });
        }
      }
      break;
    }

    default:
      // Unknown/reserved types are ignored by the reducer.
      break;
  }
}
