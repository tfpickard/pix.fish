import { deleteAllClerks } from '@/lib/db/queries/clerks';
import { deleteAllCrossReferences } from '@/lib/db/queries/cross-references';
import { deleteAllDistricts } from '@/lib/db/queries/districts';
import { listAllEvents } from '@/lib/db/queries/events';
import { deleteAllLoreFragments } from '@/lib/db/queries/lore-fragments';
import { deleteAllSpecimens } from '@/lib/db/queries/specimens';
import type { UniverseEvent } from '@/lib/db/schema';
import { buildCoordsMap } from './coords';
import { applyEvent } from './reduce';

// Apply a single freshly-appended event to the projections, without a full
// rebuild. Used by the Phase 2 evolution loop so an amendment lands in the
// specimen/lore_fragment projections immediately. Builds a coords map once per
// call (two cheap projection reads); fine at the loop's low cadence.
export async function materializeEvent(ev: UniverseEvent): Promise<void> {
  const coords = await buildCoordsMap();
  await applyEvent(ev, { coords });
}

// Rebuild every projection from the event log alone. This is the documented
// reconciliation routine: it clears the projection tables (never the events)
// and replays the log in id order through the reducers. No AI calls -- the
// dossier embeddings come from the canon event payloads.
//
// Used by scripts/universe-rebuild.ts and at the tail of the bootstrap, so the
// bootstrap always leaves projections exactly equal to a clean replay.
export async function rebuildProjections(): Promise<{ events: number }> {
  // Clearing lore_fragments cascades to their lore embeddings via FK; image
  // caption embeddings are untouched (different subject). DELETE rather than
  // TRUNCATE so we never cascade-truncate the shared embeddings table.
  await deleteAllLoreFragments();
  await deleteAllSpecimens();
  await deleteAllCrossReferences();
  await deleteAllDistricts();
  await deleteAllClerks();

  const coords = await buildCoordsMap();
  const events = await listAllEvents();
  for (const ev of events) {
    await applyEvent(ev, { coords });
  }
  return { events: events.length };
}
