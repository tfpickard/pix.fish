/**
 * Re-point every stored blob URL from Vercel Blob onto the R2 public domain.
 *
 *   bun scripts/rewrite-blob-urls.ts                    # report what it would do
 *   bun scripts/rewrite-blob-urls.ts --apply            # actually write
 *   bun scripts/rewrite-blob-urls.ts --rollback <file>  # restore a dump
 *
 * Why this exists, and why it is separate from the copy.
 *
 * scripts/migrate-blobs-to-r2.ts copies bytes and touches no rows, so it is
 * safe to run repeatedly days before a cutover while the live site still serves
 * from Vercel. This script is the other half: the single step in the whole
 * migration that mutates production data. Keeping them apart means the risky
 * part is one short, reversible transaction rather than something tangled up
 * with a multi-hour transfer.
 *
 * Nothing here derives a URL by string-munging the old one. Both tables already
 * carry `blob_key` next to `blob_url`, and that key is the durable pointer --
 * it is correct under either host and this script never changes it. So every
 * new URL is built from the key, and the derivative ladder is rebuilt through
 * the same `derivativeKey` helper the app and the copy script use. A rewrite
 * that parsed the old URLs instead would silently diverge the moment a key
 * contained anything the parser did not expect.
 *
 * Reversibility is the point of the dump. Before a single row changes, every
 * (table, id, old value) tuple goes to a timestamped JSON file on disk, and
 * --rollback feeds it straight back. The runbook keeps the Vercel Blob data
 * alive for ~2 weeks after cutover precisely so that this file stays useful.
 *
 * The sample check runs BEFORE the transaction opens, not after. A rewrite that
 * commits and then discovers R2 is missing the objects has already broken the
 * gallery for every visitor; one that checks first simply refuses to run and
 * tells you to finish the copy.
 *
 * Idempotent: a row whose blob_url already points at R2_PUBLIC_BASE is counted
 * as done and skipped, so an interrupted run can be repeated.
 *
 * Requires POSTGRES_URL with write access and R2_PUBLIC_BASE.
 */
import { eq, inArray } from 'drizzle-orm';
import { writeFileSync, readFileSync } from 'node:fs';
import { db } from '../src/lib/db/client';
import { images, characterCrops } from '../src/lib/db/schema';
import { derivativeKey } from '../src/lib/images/generate';
import type { ImageDerivatives } from '../src/lib/images/derivatives';

// How many freshly computed URLs to probe against R2 before touching anything.
// Small enough to be quick, large enough to catch a copy that never ran or that
// landed under a different prefix.
const SAMPLE_SIZE = 25;
// Rows per UPDATE batch. Correctness over throughput here: this runs once.
const CHUNK = 200;

type ImageDump = { id: number; blobUrl: string; derivatives: ImageDerivatives | null };
type CropDump = { id: number; blobUrl: string };
type Dump = {
  generatedAt: string;
  r2PublicBase: string;
  images: ImageDump[];
  crops: CropDump[];
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} not set. Aborting.`);
    process.exit(1);
  }
  return v;
}

// Trailing slashes would produce `base//key`, which R2 serves as a DIFFERENT
// object (an empty first path segment) rather than normalizing it away.
function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

function publicUrl(base: string, key: string): string {
  return `${base}/${key.replace(/^\/+/, '')}`;
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

async function rollback(file: string): Promise<void> {
  const dump = JSON.parse(readFileSync(file, 'utf8')) as Dump;
  console.log(
    `Rolling back ${dump.images.length} image rows and ${dump.crops.length} crop rows ` +
      `from ${file} (dumped ${dump.generatedAt}).`
  );

  await db.transaction(async (tx) => {
    for (const row of dump.images) {
      await tx
        .update(images)
        .set({ blobUrl: row.blobUrl, derivatives: row.derivatives })
        .where(eq(images.id, row.id));
    }
    for (const row of dump.crops) {
      await tx
        .update(characterCrops)
        .set({ blobUrl: row.blobUrl })
        .where(eq(characterCrops.id, row.id));
    }
  });

  console.log('Rollback complete.');
}

async function main(): Promise<void> {
  requireEnv('POSTGRES_URL');

  const rollbackIdx = process.argv.indexOf('--rollback');
  if (rollbackIdx !== -1) {
    const file = process.argv[rollbackIdx + 1];
    if (!file) {
      console.error('--rollback requires a dump file path. Aborting.');
      process.exit(1);
    }
    await rollback(file);
    return;
  }

  const base = normalizeBase(requireEnv('R2_PUBLIC_BASE'));
  const apply = process.argv.includes('--apply');

  const imageRows = await db
    .select({
      id: images.id,
      blobKey: images.blobKey,
      blobUrl: images.blobUrl,
      derivatives: images.derivatives
    })
    .from(images);
  const cropRows = await db
    .select({
      id: characterCrops.id,
      blobKey: characterCrops.blobKey,
      blobUrl: characterCrops.blobUrl
    })
    .from(characterCrops);

  // Plan every change up front so the dry run and the real run report from the
  // exact same computation, and so the sample check has real URLs to probe.
  const imagePlan: { id: number; from: ImageDump; to: Omit<ImageDump, 'id'> }[] = [];
  let alreadyDone = 0;

  for (const row of imageRows) {
    const nextUrl = publicUrl(base, row.blobKey);
    const nextDerivatives: ImageDerivatives | null = row.derivatives
      ? row.derivatives.map((d) => ({ w: d.w, url: publicUrl(base, derivativeKey(row.blobKey, d.w)) }))
      : null;

    const urlSettled = row.blobUrl === nextUrl;
    const derivativesSettled =
      JSON.stringify(row.derivatives ?? null) === JSON.stringify(nextDerivatives);
    if (urlSettled && derivativesSettled) {
      alreadyDone++;
      continue;
    }

    imagePlan.push({
      id: row.id,
      from: { id: row.id, blobUrl: row.blobUrl, derivatives: row.derivatives ?? null },
      to: { blobUrl: nextUrl, derivatives: nextDerivatives }
    });
  }

  const cropPlan: { id: number; from: CropDump; to: { blobUrl: string } }[] = [];
  for (const row of cropRows) {
    const nextUrl = publicUrl(base, row.blobKey);
    if (row.blobUrl === nextUrl) {
      alreadyDone++;
      continue;
    }
    cropPlan.push({
      id: row.id,
      from: { id: row.id, blobUrl: row.blobUrl },
      to: { blobUrl: nextUrl }
    });
  }

  console.log(
    `${imageRows.length} image rows, ${cropRows.length} crop rows scanned. ` +
      `${imagePlan.length} images and ${cropPlan.length} crops need rewriting; ` +
      `${alreadyDone} already point at ${base}.`
  );

  if (imagePlan.length === 0 && cropPlan.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Probe a sample of the NEW urls. A copy that never ran, ran against another
  // bucket, or landed under a different prefix all show up here, before any row
  // has been touched.
  const candidates = [
    ...imagePlan.map((p) => p.to.blobUrl),
    ...imagePlan.flatMap((p) => (p.to.derivatives ?? []).map((d) => d.url)),
    ...cropPlan.map((p) => p.to.blobUrl)
  ];
  const step = Math.max(1, Math.floor(candidates.length / SAMPLE_SIZE));
  const sample = candidates.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);

  console.log(`Probing ${sample.length} sample URLs against ${base} ...`);
  const results = await Promise.all(sample.map(async (u) => [u, await probe(u)] as const));
  const missing = results.filter(([, ok]) => !ok).map(([u]) => u);

  if (missing.length > 0) {
    console.error(
      `\n${missing.length}/${sample.length} sample URLs did not return 200. ` +
        `Run scripts/migrate-blobs-to-r2.ts --apply to completion first.\n`
    );
    for (const u of missing.slice(0, 10)) console.error(`  missing: ${u}`);
    process.exit(1);
  }
  console.log(`All ${sample.length} sample URLs resolved.`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write. Examples of planned changes:');
    for (const p of imagePlan.slice(0, 3)) {
      console.log(`  image ${p.id}:`);
      console.log(`    ${p.from.blobUrl}`);
      console.log(` -> ${p.to.blobUrl}`);
    }
    for (const p of cropPlan.slice(0, 2)) {
      console.log(`  crop ${p.id}:`);
      console.log(`    ${p.from.blobUrl}`);
      console.log(` -> ${p.to.blobUrl}`);
    }
    return;
  }

  // Dump BEFORE mutating. This file is the entire rollback story, so it is
  // written and flushed before the transaction opens rather than alongside it.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpPath = `blob-url-rollback-${stamp}.json`;
  const dump: Dump = {
    generatedAt: new Date().toISOString(),
    r2PublicBase: base,
    images: imagePlan.map((p) => p.from),
    crops: cropPlan.map((p) => p.from)
  };
  writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
  console.log(`Rollback dump written to ${dumpPath}. Keep it until the cutover is settled.`);

  await db.transaction(async (tx) => {
    let done = 0;
    for (const p of imagePlan) {
      await tx
        .update(images)
        .set({ blobUrl: p.to.blobUrl, derivatives: p.to.derivatives })
        .where(eq(images.id, p.id));
      if (++done % CHUNK === 0) console.log(`  ${done}/${imagePlan.length} images ...`);
    }
    done = 0;
    for (const p of cropPlan) {
      await tx.update(characterCrops).set({ blobUrl: p.to.blobUrl }).where(eq(characterCrops.id, p.id));
      if (++done % CHUNK === 0) console.log(`  ${done}/${cropPlan.length} crops ...`);
    }
  });

  console.log(
    `\nRewrote ${imagePlan.length} image rows and ${cropPlan.length} crop rows onto ${base}.`
  );
  console.log(`Rollback: bun scripts/rewrite-blob-urls.ts --rollback ${dumpPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
