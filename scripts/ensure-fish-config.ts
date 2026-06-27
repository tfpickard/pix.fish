/**
 * Ensures the `fish_config` table exists and is seeded with defaults.
 *
 * The pix-fish morph tunables (edited at /admin/fish) live in this table.
 * `drizzle-kit push` would create it, but it diffs the whole schema against the
 * live DB; this script is surgical and idempotent (CREATE TABLE IF NOT EXISTS +
 * ON CONFLICT DO NOTHING), mirroring scripts/ensure-pgvector.ts. Until it runs,
 * the mascot still works (reads fall back to defaults) but /admin/fish saves
 * fail because there's nothing to write to.
 *
 * Safe to run repeatedly. Point it at the target database via POSTGRES_URL:
 *
 *   POSTGRES_URL="<prod connection string>" bun scripts/ensure-fish-config.ts
 */
import { sql } from '@vercel/postgres';
import { DEFAULT_FISH_MORPH_CONFIG, fishConfigToFields } from '../src/lib/fish/config';

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS fish_config (
      id serial PRIMARY KEY,
      field text NOT NULL UNIQUE,
      value text NOT NULL,
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `;

  // Seed defaults without clobbering any existing admin edits.
  const fields = fishConfigToFields(DEFAULT_FISH_MORPH_CONFIG);
  for (const [field, value] of Object.entries(fields)) {
    await sql`
      INSERT INTO fish_config (field, value)
      VALUES (${field}, ${value})
      ON CONFLICT (field) DO NOTHING
    `;
    console.log(`  - ensured fish_config["${field}"] (default ${value})`);
  }

  const res = await sql<{ count: string }>`SELECT count(*)::int AS count FROM fish_config`;
  console.log(`fish_config ok (${res.rows[0]?.count ?? '?'} rows)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
