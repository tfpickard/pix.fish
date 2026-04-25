/**
 * Phase A pre-push bootstrap. Run this BEFORE `bun run db:push`.
 *
 * db:push tries to add the images.owner_id -> users.id FK, but if the
 * users table doesn't exist yet (or doesn't have a row matching the
 * existing image owners) the FK addition fails with code 23503. This
 * script creates the users table and inserts the bootstrap admin row up
 * front so db:push has a valid FK target.
 *
 * Idempotent: safe to re-run. CREATE TABLE IF NOT EXISTS + ON CONFLICT
 * means subsequent runs are a no-op.
 *
 * Run order for a fresh multi-user upgrade:
 *   1. bun scripts/prepare-multiuser.ts     (this script)
 *   2. bun run db:push                       (drizzle applies the rest)
 *   3. bun scripts/backfill-multiuser.ts    (legacy-row owner_id, indexes)
 *   4. bun run db:seed                       (idempotent prompt + about seeds)
 *
 * Usage:
 *   POSTGRES_URL=... OWNER_GITHUB_ID=... bun scripts/prepare-multiuser.ts
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

  console.log('Bootstrapping users table + admin row before db:push...');

  await step('create users table if absent', () =>
    db.execute(sql`
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY,
        handle text NOT NULL UNIQUE,
        display_name text,
        avatar_url text,
        email text,
        provider text NOT NULL DEFAULT 'github',
        role text NOT NULL DEFAULT 'user',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
  );

  await step(`insert admin user (id=${ownerId} handle=${ownerHandle})`, () =>
    db.execute(sql`
      INSERT INTO users (id, handle, role, provider)
      VALUES (${ownerId}, ${ownerHandle}, 'admin', 'github')
      ON CONFLICT (id) DO UPDATE SET role = 'admin', updated_at = now()
    `)
  );

  console.log('Done. Now run `bun run db:push` to apply the rest of the schema.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
