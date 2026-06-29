/**
 * Reconciliation checks for the character layer (Phase 3). Exits non-zero on
 * any failure. Safe to run repeatedly; the rebuild round-trip only rewrites
 * projections from the event log, never the canon.
 *
 *   bun scripts/verify-characters.ts
 *
 * Checks:
 *   1. crops exist (detection ran)
 *   2. characters exist (a census was filed)
 *   3. each character's appearanceCount == its materialized appearances
 *   4. projection counts are stable across a rebuild from the log alone
 */
import { countCharacterCrops } from '../src/lib/db/queries/character-crops';
import {
  countCharacters,
  getCharacter,
  listAppearances,
  listCharacters
} from '../src/lib/db/queries/characters';
import { getClerk } from '../src/lib/db/queries/clerks';
import { rebuildProjections } from '../src/lib/universe/materialize';

async function main() {
  const failures: string[] = [];
  const ok = (m: string) => console.log(`  ok   ${m}`);
  const fail = (m: string) => {
    console.error(`  FAIL ${m}`);
    failures.push(m);
  };

  console.log('character reconciliation:');

  const crops = await countCharacterCrops();
  if (crops > 0) ok(`character crops on file (${crops})`);
  else fail('no character crops -- run detection first');

  const charCount = await countCharacters();
  if (charCount > 0) ok(`recurring characters materialized (${charCount})`);
  else fail('no characters -- run the cluster/census first');

  // appearanceCount matches the materialized appearances per character.
  const chars = await listCharacters();
  let mismatched = 0;
  for (const c of chars) {
    const n = (await listAppearances(c.key)).length;
    if (n !== c.appearanceCount) {
      mismatched++;
      if (mismatched <= 3) fail(`${c.key} appearanceCount ${c.appearanceCount} != ${n} appearances`);
    }
  }
  if (mismatched === 0 && chars.length > 0) ok('appearance counts reconcile');

  // Spot-check one character.
  const [sample] = chars;
  if (sample) {
    const clerk = await getClerk(sample.clerkSlug).catch(() => null);
    console.log(`  spot-check ${sample.key}: "${sample.name}" by ${clerk?.name ?? sample.clerkSlug}, ${sample.appearanceCount} appearances`);
    console.log(`    dossier opens: "${sample.dossier.slice(0, 120)}..."`);
  }

  // Rebuild round-trip: the newest census should reproduce the same roster.
  const before = charCount;
  await rebuildProjections();
  const after = await countCharacters();
  if (after === before) ok('character count stable across rebuild from the log');
  else fail(`rebuild changed character count: ${before} -> ${after}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nall checks passed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
