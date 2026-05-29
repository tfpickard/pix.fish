/**
 * Creates the Gate-0 parallel-build feature tables/columns idempotently,
 * without relying on `drizzle-kit push`.
 *
 * This is the migration-collision strategy for the six parallel worktrees:
 * all additive schema lands here (and in schema.ts) once, at Gate 0, so no two
 * feature branches fight over drizzle/ numbering. The human generates the
 * consolidated numbered migration via `bun run db:generate` at integration.
 *
 *   bun scripts/ensure-features.ts
 *
 * Safe to run repeatedly -- every statement is IF NOT EXISTS / ADD COLUMN IF
 * NOT EXISTS. Mirrors scripts/ensure-playground-tables.ts.
 */
import { sql } from '@vercel/postgres';

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.error('POSTGRES_URL not set. Aborting.');
    process.exit(1);
  }

  // feat/hud + feat/alive + feat/basement: additive columns on images.
  await sql`ALTER TABLE "images" ADD COLUMN IF NOT EXISTS "surprisal" real`;
  await sql`ALTER TABLE "images" ADD COLUMN IF NOT EXISTS "generation" integer DEFAULT 0 NOT NULL`;
  await sql`ALTER TABLE "images" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone`;
  await sql`ALTER TABLE "images" ADD COLUMN IF NOT EXISTS "basement" boolean DEFAULT false NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS "images_surprisal_idx" ON "images" USING btree ("surprisal")`;
  await sql`CREATE INDEX IF NOT EXISTS "images_archived_idx" ON "images" USING btree ("archived_at")`;
  await sql`CREATE INDEX IF NOT EXISTS "images_basement_idx" ON "images" USING btree ("basement")`;

  // feat/hud: collection temperature time series.
  await sql`
    CREATE TABLE IF NOT EXISTS "collection_temperature" (
      "id" serial PRIMARY KEY NOT NULL,
      "value" real NOT NULL,
      "point_count" integer DEFAULT 0 NOT NULL,
      "meta" jsonb,
      "computed_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS "collection_temperature_computed_idx" ON "collection_temperature" USING btree ("computed_at")`;

  // feat/manifold: 3D embedding projection.
  await sql`
    CREATE TABLE IF NOT EXISTS "manifold_projections" (
      "id" serial PRIMARY KEY NOT NULL,
      "seed" integer NOT NULL,
      "points" jsonb NOT NULL,
      "point_count" integer NOT NULL,
      "params" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS "manifold_projections_created_idx" ON "manifold_projections" USING btree ("created_at")`;

  // feat/geodesics: kNN graph over caption embeddings.
  await sql`
    CREATE TABLE IF NOT EXISTS "knn_edges" (
      "id" serial PRIMARY KEY NOT NULL,
      "src_id" integer NOT NULL REFERENCES "images"("id") ON DELETE cascade,
      "dst_id" integer NOT NULL REFERENCES "images"("id") ON DELETE cascade,
      "dist" real NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS "knn_edges_src_idx" ON "knn_edges" USING btree ("src_id")`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "knn_edges_src_dst_uniq" ON "knn_edges" USING btree ("src_id","dst_id")`;

  // feat/stigmergy: per-image decayed attention.
  await sql`
    CREATE TABLE IF NOT EXISTS "image_attention" (
      "image_id" integer PRIMARY KEY NOT NULL REFERENCES "images"("id") ON DELETE cascade,
      "value" real DEFAULT 0 NOT NULL,
      "last_updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;

  const res = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN (
      'collection_temperature', 'manifold_projections', 'knn_edges', 'image_attention'
    )
    ORDER BY table_name
  `;
  console.log('feature tables present:', res.rows.map((r) => r.table_name).join(', ') || '(none)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
