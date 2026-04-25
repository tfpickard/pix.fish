/**
 * Phase A backfill. Apply this AFTER `bun run db:push` so the new schema
 * (users table, owner_id columns, NSFW columns, etc.) exists. The script
 * is idempotent: safe to re-run as many times as you like.
 *
 *   - Inserts the bootstrap site-admin user from OWNER_GITHUB_ID.
 *   - Backfills owner_id on existing rows (saved_prompts, about_fields,
 *     webhooks, gallery_config) to the admin's id so the new NOT NULL
 *     column doesn't reject the data.
 *   - Drops the old global slug unique on images, adds the composite
 *     (owner_id, slug) unique so each user has an independent slug
 *     namespace.
 *   - Drops the about_fields key-only unique in favor of (owner_id, key).
 *
 * Usage:
 *   POSTGRES_URL=... OWNER_GITHUB_ID=... bun scripts/backfill-multiuser.ts
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db/client';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function step(label: string, run: () => Promise<unknown>) {
  process.stdout.write(`  - ${label} ... `);
  await run();
  console.log('ok');
}

async function main() {
  const ownerId = need('OWNER_GITHUB_ID');
  const ownerHandle = process.env.OWNER_HANDLE || 'admin';

  console.log(`Bootstrapping site admin: id=${ownerId} handle=${ownerHandle}`);
  await step('upsert admin user', () =>
    db.execute(sql`
      INSERT INTO users (id, handle, role, provider)
      VALUES (${ownerId}, ${ownerHandle}, 'admin', 'github')
      ON CONFLICT (id) DO UPDATE SET role = 'admin', updated_at = now()
    `)
  );

  console.log('Backfilling owner_id on rows that pre-date the multi-user schema...');
  await step('saved_prompts.owner_id <- admin where null', () =>
    db.execute(sql`UPDATE saved_prompts SET owner_id = ${ownerId} WHERE owner_id IS NULL`)
  );
  await step('about_fields.owner_id <- admin where null', () =>
    db.execute(sql`UPDATE about_fields SET owner_id = ${ownerId} WHERE owner_id IS NULL`)
  );
  await step('webhooks.owner_id <- admin where null', () =>
    db.execute(sql`UPDATE webhooks SET owner_id = ${ownerId} WHERE owner_id IS NULL`)
  );
  await step('gallery_config.owner_id <- admin where null', () =>
    db.execute(sql`UPDATE gallery_config SET owner_id = ${ownerId} WHERE owner_id IS NULL`)
  );

  console.log('Reconciling unique constraints (idempotent)...');
  await step('drop legacy images_slug_unique if present', () =>
    db.execute(sql`ALTER TABLE images DROP CONSTRAINT IF EXISTS images_slug_unique`)
  );
  await step('add (owner_id, slug) unique on images', () =>
    db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS images_owner_slug_uniq ON images (owner_id, slug)`)
  );
  await step('drop legacy about_fields_key_unique if present', () =>
    db.execute(sql`ALTER TABLE about_fields DROP CONSTRAINT IF EXISTS about_fields_key_unique`)
  );
  await step('add (owner_id, key) unique on about_fields', () =>
    db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS about_fields_owner_key_uniq ON about_fields (owner_id, key)`
    )
  );
  await step('drop legacy gallery_config_pkey if present', () =>
    db.execute(sql`ALTER TABLE gallery_config DROP CONSTRAINT IF EXISTS gallery_config_pkey`)
  );
  await step('add (owner_id, key) unique on gallery_config', () =>
    db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS gallery_config_owner_key_pk ON gallery_config (owner_id, key)`
    )
  );
  await step('add nsfw index on images', () =>
    db.execute(sql`CREATE INDEX IF NOT EXISTS images_is_nsfw_idx ON images (is_nsfw)`)
  );

  console.log('Done. Run `bun run db:seed` next to ensure default rows exist.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
