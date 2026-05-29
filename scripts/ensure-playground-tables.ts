/**
 * Creates the Phase 5 playground tables (vibe_axes, remix_idioms,
 * image_lineage) idempotently, without relying on `drizzle-kit push`.
 *
 * `drizzle-kit push` runs with `strict: true` (drizzle.config.ts), so it waits
 * for an interactive confirmation and can no-op or abort on the pgvector type
 * diff -- the same class of problem that motivated ensure-pgvector.ts. When
 * `db:push` leaves you with "relation \"remix_idioms\" does not exist" during
 * db:seed, run this first:
 *
 *   bun scripts/ensure-playground-tables.ts
 *   bun run db:seed
 *
 * Safe to run repeatedly -- every statement is IF NOT EXISTS.
 */
import { sql } from '@vercel/postgres';

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.error('POSTGRES_URL not set. Aborting.');
    process.exit(1);
  }

  await sql`
    CREATE TABLE IF NOT EXISTS "vibe_axes" (
      "id" serial PRIMARY KEY NOT NULL,
      "key" text NOT NULL,
      "label" text NOT NULL,
      "description" text,
      "negative_pole" text NOT NULL,
      "positive_pole" text NOT NULL,
      "ordering" integer DEFAULT 0 NOT NULL,
      "version" integer DEFAULT 1 NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "vibe_axes_key_uniq" ON "vibe_axes" USING btree ("key")`;

  await sql`
    CREATE TABLE IF NOT EXISTS "remix_idioms" (
      "id" serial PRIMARY KEY NOT NULL,
      "key" text NOT NULL,
      "label" text NOT NULL,
      "description" text NOT NULL,
      "active" boolean DEFAULT true NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "remix_idioms_key_uniq" ON "remix_idioms" USING btree ("key")`;

  await sql`
    CREATE TABLE IF NOT EXISTS "image_lineage" (
      "id" serial PRIMARY KEY NOT NULL,
      "child_image_id" integer NOT NULL REFERENCES "images"("id") ON DELETE cascade,
      "parent_image_id" integer NOT NULL REFERENCES "images"("id") ON DELETE cascade,
      "prompt_used" text,
      "dialect_used" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "image_lineage_child_parent_uniq" ON "image_lineage" USING btree ("child_image_id","parent_image_id")`;
  await sql`CREATE INDEX IF NOT EXISTS "image_lineage_child_idx" ON "image_lineage" USING btree ("child_image_id")`;
  await sql`CREATE INDEX IF NOT EXISTS "image_lineage_parent_idx" ON "image_lineage" USING btree ("parent_image_id")`;

  const res = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('vibe_axes', 'remix_idioms', 'image_lineage')
    ORDER BY table_name
  `;
  console.log('playground tables present:', res.rows.map((r) => r.table_name).join(', ') || '(none)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
