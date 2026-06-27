/**
 * Rebuild every universe projection from the event log alone.
 *
 * Truncates the projection tables (specimens, districts, clerks,
 * cross_references, lore_fragments + their lore embeddings) and replays the
 * append-only `events` log in id order through the reducers. Makes zero AI
 * calls -- dossier embeddings are restored from the canon event payloads.
 *
 * The `events` table itself is never touched. This is the documented command
 * that proves the projections are fully derived from the log.
 *
 *   bun scripts/universe-rebuild.ts
 */
import { rebuildProjections } from '../src/lib/universe/materialize';

async function main() {
  console.log('rebuilding projections from the event log...');
  const { events } = await rebuildProjections();
  console.log(`done: replayed ${events} events`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
