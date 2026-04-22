/**
 * Enables the pgvector extension on the target Postgres.
 *
 * `drizzle-kit push` diffs schema vs live DB but skips the CREATE EXTENSION
 * in drizzle/0000_init.sql, which is how we arrived at "type vector does not
 * exist" when adding the Phase 2 embeddings table.
 *
 * Safe to run repeatedly -- idempotent via IF NOT EXISTS.
 *
 *   bun scripts/ensure-pgvector.ts
 */
import { sql } from '@vercel/postgres';

async function main() {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  const res = await sql<{ extversion: string }>`
    SELECT extversion FROM pg_extension WHERE extname = 'vector'
  `;
  const version = res.rows[0]?.extversion;
  console.log(version ? `pgvector ok (version ${version})` : 'pgvector missing after CREATE -- something is wrong');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
