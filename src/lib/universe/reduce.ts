import type { UniverseEvent } from '@/lib/db/schema';
import { upsertClerk } from '@/lib/db/queries/clerks';
import { upsertCrossReference } from '@/lib/db/queries/cross-references';
import { upsertDistrict } from '@/lib/db/queries/districts';
import { upsertLoreEmbedding } from '@/lib/db/queries/embeddings';
import { upsertLoreFragment } from '@/lib/db/queries/lore-fragments';
import { getSpecimen, upsertSpecimen } from '@/lib/db/queries/specimens';
import { coordsFor, type CoordsMap } from './coords';
import {
  EVENT_TYPE,
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
      // Reserved for Phase 2 (autonomous amendments). Not emitted in Phase 1,
      // but handled here so the projection stays rebuildable once it is: append
      // a new fragment, advance the current dossier, and bump the generation.
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
      await upsertSpecimen({
        imageId,
        clerkSlug,
        districtKey: existing?.districtKey ?? p.districtKey,
        currentDossier: p.dossier,
        citations: ev.citations,
        intakeEventId: existing?.intakeEventId ?? ev.id,
        generation: (existing?.generation ?? 0) + 1,
        updatedAt: ev.createdAt
      });
      break;
    }

    default:
      // Unknown/reserved types are ignored by the Phase 1 reducer.
      break;
  }
}
