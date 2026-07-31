/**
 * Bring the live `dispatch_caption` prompt row up to the checked-in default,
 * WITHOUT clobbering an admin's edits.
 *
 *   bun scripts/sync-dispatch-prompt.ts          # report what it would do
 *   bun scripts/sync-dispatch-prompt.ts --apply  # actually write
 *
 * Why this exists. `buildCaptionPrompt` prefers the DB row and falls back to
 * DEFAULT_DISPATCH_CAPTION_TEMPLATE only when the row is absent. So on any
 * install that has run `db:seed`, editing the constant changes nothing: the
 * deployment keeps generating captions from the older stored template. The
 * obvious remedy -- re-running the seed -- is worse, because its upsert
 * overwrites the template of EVERY prompt key, discarding whatever the admin has
 * tuned at /admin/prompts. That is the whole point of the prompt being editable
 * without a redeploy.
 *
 * So this compares the stored template against the hashes of the defaults this
 * repo has actually shipped. Matching one means nobody has touched it and it is
 * safe to move forward. Not matching means the row is customized -- and a
 * customized prompt is the admin's, not ours, so it is reported and left exactly
 * as it is. Judging "unmodified" by content rather than by the version column is
 * deliberate: version is bumped by promotion from the prompt composer too, so it
 * records that a change happened, not who intended it.
 *
 * Requires POSTGRES_URL with write access (the read-only role used by the dry-run
 * workflow will not do).
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db/client';
import { prompts } from '../src/lib/db/schema';
import { DEFAULT_DISPATCH_CAPTION_TEMPLATE } from '../src/lib/dispatch/caption';

const KEY = 'dispatch_caption';

// sha256 of every DEFAULT_DISPATCH_CAPTION_TEMPLATE this repo has shipped, oldest
// first. A stored template matching any of these was seeded and never edited.
// Append the outgoing hash here whenever the constant changes -- a default that
// is not on this list looks like an admin edit and will be left alone forever.
const SHIPPED_DEFAULT_HASHES = [
  // Phase F initial (PR #62).
  '2e1c453526cdd3fbcb211b9b205aee8113cda8f21cfb08c0fc7d3d2f9ef18f14'
];

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.error('POSTGRES_URL not set. Aborting.');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  const target = hash(DEFAULT_DISPATCH_CAPTION_TEMPLATE);

  const [row] = await db
    .select()
    .from(prompts)
    .where(sql`${prompts.key} = ${KEY}`)
    .limit(1);

  if (!row) {
    console.log(`no "${KEY}" row: the fallback constant is already what runs.`);
    if (!apply) {
      console.log('would insert it so the prompt becomes editable at /admin/prompts.');
      return;
    }
    // Same reasoning as the update below: if the row appeared between the SELECT
    // and here, the insert must yield to it rather than race the unique index.
    const inserted = await db
      .insert(prompts)
      .values({ key: KEY, template: DEFAULT_DISPATCH_CAPTION_TEMPLATE, version: 1 })
      .onConflictDoNothing({ target: prompts.key })
      .returning({ version: prompts.version });
    if (inserted.length === 0) {
      console.log('a row appeared while this script was running -- nothing was written.');
      console.log('re-run it to see the current state.');
      process.exitCode = 1;
      return;
    }
    console.log('inserted.');
    return;
  }

  const current = hash(row.template);
  if (current === target) {
    console.log(`"${KEY}" is already the current default (v${row.version}). Nothing to do.`);
    return;
  }

  if (!SHIPPED_DEFAULT_HASHES.includes(current)) {
    console.log(`"${KEY}" (v${row.version}) does not match any default this repo has shipped.`);
    console.log('Treating it as an admin edit and leaving it alone.');
    console.log('If you want the new default, replace it yourself at /admin/prompts.');
    return;
  }

  console.log(`"${KEY}" (v${row.version}) is an unmodified older default.`);
  if (!apply) {
    console.log('would update it to the current default and bump the version. Re-run with --apply.');
    return;
  }
  // Compare-and-set on the template we actually read. Matching on the key alone
  // would make the "unmodified" check advisory: an admin saving an edit, or a
  // promotion from the prompt composer, between the SELECT above and this UPDATE
  // would be silently overwritten by the very script whose only job is to not do
  // that. The window is small and this is a hand-run script, but the guarantee is
  // the entire reason it exists, so it belongs in the predicate rather than in
  // the gap between two statements.
  const updated = await db
    .update(prompts)
    .set({
      template: DEFAULT_DISPATCH_CAPTION_TEMPLATE,
      version: row.version + 1,
      updatedAt: sql`now()`
    })
    .where(sql`${prompts.key} = ${KEY} AND ${prompts.template} = ${row.template}`)
    .returning({ version: prompts.version });

  if (updated.length === 0) {
    console.log('the row changed while this script was running -- nothing was written.');
    console.log('re-run it to see the current state.');
    process.exitCode = 1;
    return;
  }
  console.log(`updated to v${updated[0]!.version}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
