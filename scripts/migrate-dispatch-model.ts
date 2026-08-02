/**
 * Move the live `ai_config` dispatch rows onto the split defaults, WITHOUT
 * clobbering an owner's choice.
 *
 *   bun scripts/migrate-dispatch-model.ts          # report what it would do
 *   bun scripts/migrate-dispatch-model.ts --apply  # actually write
 *
 * Why this exists. The dispatch pipeline used to route both of its LLM calls --
 * the trend safety classifier and the caption -- through one `dispatch` row,
 * defaulted to Haiku. They now have separate rows, because they want opposite
 * things from a model: the caption is the deliverable and earns a better tier,
 * while the classifier is mechanical JSON under a deadline that has to fit
 * inside a 50s job.
 *
 * Changing defaultAiConfig alone does not reach an existing install. loadAiConfig
 * prefers a stored row, and scripts/seed.ts deliberately preserves rows on
 * conflict so it cannot discard owner edits. So an install seeded before the
 * split keeps writing captions with the classifier's cheap model, silently, and
 * the whole point of the split is lost on exactly the deployments that already
 * exist.
 *
 * The same reasoning as sync-dispatch-prompt.ts applies to who owns the value:
 * a row still equal to a default this repo shipped was never chosen by anyone
 * and is safe to advance. A row holding anything else is the owner's and is
 * reported, not touched.
 *
 * Requires POSTGRES_URL with write access.
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db/client';
import { aiConfig } from '../src/lib/db/schema';
import { defaultAiConfig } from '../src/lib/ai/config';

// The value `dispatch` was seeded with while it drove both calls. A row still
// holding this was never a decision about caption quality -- it was the
// classifier's default, inherited by the caption because they shared a row.
const FORMER_SHARED_DEFAULT = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' };

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.error('POSTGRES_URL not set. Aborting.');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');

  const rows = await db.select().from(aiConfig);
  const byField = new Map(rows.map((r) => [r.field, r] as const));

  // 1. The caption row. Advance it only if it still holds the former shared
  //    default; anything else is a deliberate choice.
  const dispatchRow = byField.get('dispatch');
  const want = defaultAiConfig.dispatch;
  if (!dispatchRow) {
    console.log('no "dispatch" row: loadAiConfig already falls back to the new default.');
  } else if (
    dispatchRow.provider === FORMER_SHARED_DEFAULT.provider &&
    dispatchRow.model === FORMER_SHARED_DEFAULT.model
  ) {
    console.log(
      `"dispatch" holds the former shared default (${dispatchRow.provider}/${dispatchRow.model}).`
    );
    console.log(`  ${apply ? 'updating' : 'would update'} to ${want.provider}/${want.model}`);
    if (apply) {
      await db
        .update(aiConfig)
        .set({ provider: want.provider, model: want.model, updatedAt: new Date() })
        .where(sql`${aiConfig.field} = 'dispatch'`);
    }
  } else {
    console.log(
      `"dispatch" is ${dispatchRow.provider}/${dispatchRow.model} -- an owner choice, left alone.`
    );
  }

  // 2. The classifier row. Purely additive: it did not exist before the split, so
  //    creating it cannot overwrite anyone's decision. Skipped if present for the
  //    same reason.
  const safetyRow = byField.get('dispatchSafety');
  const wantSafety = defaultAiConfig.dispatchSafety;
  if (safetyRow) {
    console.log(
      `"dispatchSafety" already exists (${safetyRow.provider}/${safetyRow.model}), left alone.`
    );
  } else {
    console.log(
      `  ${apply ? 'inserting' : 'would insert'} "dispatchSafety" as ${wantSafety.provider}/${wantSafety.model}`
    );
    if (apply) {
      await db
        .insert(aiConfig)
        .values({ field: 'dispatchSafety', provider: wantSafety.provider, model: wantSafety.model })
        // A concurrent seed run may have created it first; yield to it rather
        // than race the unique index.
        .onConflictDoNothing({ target: aiConfig.field });
    }
  }

  if (!apply) console.log('\ndry run. re-run with --apply to write.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
