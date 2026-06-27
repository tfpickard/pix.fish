/**
 * Reconciliation checks for the universe layer. Asserts the Phase 1 "done
 * when" invariants and exits non-zero on any failure. Safe to run repeatedly;
 * read-only except for the rebuild round-trip (which only rewrites projections
 * from the log, never the canon).
 *
 *   bun scripts/verify-universe.ts
 *
 * Checks:
 *   1. specimens count == images count
 *   2. every image has >= 1 lore fragment
 *   3. specimen.intake event count == specimens count (one intake per specimen)
 *   4. a phrase from a real dossier is findable via lore search (co-embedding)
 *   5. projection counts are stable across a rebuild from the log alone
 */
import { sql } from 'drizzle-orm';
import { getEmbedder, loadUserProviderKeys } from '../src/lib/ai';
import { loadAiConfig } from '../src/lib/ai/loadConfig';
import { db } from '../src/lib/db/client';
import { specimens } from '../src/lib/db/schema';
import { searchLoreByVector } from '../src/lib/db/queries/embeddings';
import { listAllEvents } from '../src/lib/db/queries/events';
import { countImagesWithLoreFragments, countLoreFragmentsForImage } from '../src/lib/db/queries/lore-fragments';
import { countSpecimens } from '../src/lib/db/queries/specimens';
import { getSiteAdminId } from '../src/lib/db/queries/users';
import { EVENT_TYPE } from '../src/lib/universe/events';
import { rebuildProjections } from '../src/lib/universe/materialize';

async function countImages(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM images`);
  return Number(res.rows?.[0]?.n ?? 0);
}

async function main() {
  const failures: string[] = [];
  const ok = (msg: string) => console.log(`  ok   ${msg}`);
  const fail = (msg: string) => {
    console.error(`  FAIL ${msg}`);
    failures.push(msg);
  };

  const images = await countImages();
  const specimenCount = await countSpecimens();
  const imagesWithLore = await countImagesWithLoreFragments();

  console.log('universe reconciliation:');

  // 1. specimens == images
  if (specimenCount === images) ok(`specimens == images (${specimenCount})`);
  else fail(`specimens (${specimenCount}) != images (${images})`);

  // 2. every image has a lore fragment
  if (imagesWithLore === images) ok(`every image has a lore fragment (${imagesWithLore})`);
  else fail(`images with lore fragments (${imagesWithLore}) != images (${images})`);

  // 3. one specimen.intake event per specimen
  const events = await listAllEvents();
  const intakeCount = events.filter((e) => e.type === EVENT_TYPE.SpecimenIntake).length;
  if (intakeCount === specimenCount) ok(`specimen.intake events == specimens (${intakeCount})`);
  else fail(`specimen.intake events (${intakeCount}) != specimens (${specimenCount})`);

  // 4. co-embedding: a dossier phrase returns its fragment
  const [aSpecimen] = await db
    .select({ imageId: specimens.imageId, dossier: specimens.currentDossier })
    .from(specimens)
    .limit(1);
  if (!aSpecimen) {
    fail('no specimen to spot-check search');
  } else {
    const cfg = await loadAiConfig();
    const embedder = getEmbedder(cfg, await loadUserProviderKeys(getSiteAdminId()));
    if (!embedder) {
      console.log('  skip search check (no embedder key available)');
    } else {
      const phrase = aSpecimen.dossier.split(/\s+/).slice(0, 14).join(' ');
      const vec = await embedder.embed(phrase);
      const matches = await searchLoreByVector(vec, { limit: 5 });
      const hit = matches.findIndex((m) => m.specimenImageId === aSpecimen.imageId);
      const fragCount = await countLoreFragmentsForImage(aSpecimen.imageId);
      console.log(`  spot-check specimen image ${aSpecimen.imageId}: ${fragCount} fragment(s)`);
      console.log(`    dossier opens: "${phrase}..."`);
      if (hit === 0) ok('lore search returns the source dossier as the top match');
      else if (hit > 0) ok(`lore search returns the source dossier (rank ${hit + 1})`);
      else fail('lore search did not return the source dossier in the top 5');
    }
  }

  // 5. rebuild round-trip leaves projection counts unchanged
  const before = { specimenCount, imagesWithLore };
  await rebuildProjections();
  const after = {
    specimenCount: await countSpecimens(),
    imagesWithLore: await countImagesWithLoreFragments()
  };
  if (after.specimenCount === before.specimenCount && after.imagesWithLore === before.imagesWithLore) {
    ok('projection counts stable across rebuild from the log');
  } else {
    fail(
      `rebuild changed counts: specimens ${before.specimenCount}->${after.specimenCount}, withLore ${before.imagesWithLore}->${after.imagesWithLore}`
    );
  }

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
