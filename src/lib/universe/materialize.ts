import { deleteAllClerks } from '@/lib/db/queries/clerks';
import { deleteAllCrossReferences } from '@/lib/db/queries/cross-references';
import { deleteAllDistricts } from '@/lib/db/queries/districts';
import { listAllEvents } from '@/lib/db/queries/events';
import { deleteAllLoreFragments } from '@/lib/db/queries/lore-fragments';
import { deleteAllSpecimens } from '@/lib/db/queries/specimens';
import { buildCoordsMap } from './coords';
import { applyEvent } from './reduce';

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
