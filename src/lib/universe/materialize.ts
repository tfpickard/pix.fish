import { deleteAllAppearances, deleteAllCharacters } from '@/lib/db/queries/characters';
import { deleteAllClerks } from '@/lib/db/queries/clerks';
import { deleteAllCrossReferences } from '@/lib/db/queries/cross-references';
import { deleteAllDistricts } from '@/lib/db/queries/districts';
import { listAllEvents, listSpecimenEvents } from '@/lib/db/queries/events';
import { deleteAllLoreFragments } from '@/lib/db/queries/lore-fragments';
import { deleteAllSpecimens } from '@/lib/db/queries/specimens';
import type { UniverseEvent } from '@/lib/db/schema';
import { buildCoordsMap } from './coords';
import { applyEvent } from './reduce';

// Rebuild a single specimen's projection by replaying its full event stream
// (intake + amendments, in order). This is idempotent and order-correct:
// generation and current dossier are derived by re-folding the whole history,
// so a retry, a race, or re-applying an already-materialized amendment all
// converge to the same state -- no generation drift. Preferred over applying a
// lone amendment event, which would advance generation off already-advanced
// projection state. Bounded to one specimen's events, so cheap at loop cadence.
export async function materializeSpecimen(imageId: number): Promise<void> {
  const coords = await buildCoordsMap();
  const events = await listSpecimenEvents(imageId);
  for (const ev of events) {
    await applyEvent(ev, { coords });
  }
}

// Apply a single freshly-appended event to the projections. Used by the
// character census (the reducer clears + replaces the character projection
// from the event payload, so a one-event apply is exactly right).
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
  // Character projections (no census event -> stay empty). Crops are evidence,
  // not a projection, so they are left intact.
  await deleteAllAppearances();
  await deleteAllCharacters();

  const coords = await buildCoordsMap();
  const events = await listAllEvents();
  for (const ev of events) {
    await applyEvent(ev, { coords });
  }
  return { events: events.length };
}
