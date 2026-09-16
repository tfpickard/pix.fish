import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import * as schema from './schema';

// node-postgres, NOT neon-http. The distinction is load-bearing: this codebase
// makes 100+ `db.execute()` calls and reads `.rows` off nearly all of them.
// node-postgres returns pg's QueryResult (which has `.rows`), matching what
// @vercel/postgres returned; neon-http resolves to a bare array instead and
// would break every one of those call sites at runtime while still typechecking
// under a loose signature.
//
// The move off @vercel/postgres is also what makes a long-lived worker sane.
// That package is Neon's HTTP driver: one round trip per query, no connection
// reuse, which is the right trade for a serverless function and the wrong one
// for a process that stays up for weeks. Point POSTGRES_URL at Neon's `-pooler`
// host so the server-side pooler fronts these connections.
//
// SSL is not configured here on purpose: `pg` honours `sslmode` from the
// connection string, and Neon's URLs carry `?sslmode=require` already. Setting
// it in code would silently override whatever the operator put in the URL.
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  // Web and worker run as separate processes and each gets its own pool, so
  // this is a per-process ceiling, not a global one. Keep the sum under the
  // Neon plan's connection limit.
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

// An idle client erroring out (Neon closing an idle connection, a network
// blip) emits on the pool. Without a listener, Node treats it as an unhandled
// 'error' event and takes the whole process down -- which for the worker means
// a restart loop rather than a dropped connection the pool would have replaced.
pool.on('error', (err) => {
  console.error('postgres pool: idle client error', err);
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;

// Raw tagged-template escape hatch, shaped exactly like the `sql` export that
// @vercel/postgres provided, so the scripts that used it keep working with only
// their import line changed. Interpolated values become numbered placeholders
// rather than being pasted into the statement, so this is parameterized and not
// string concatenation.
export async function sql<T extends QueryResultRow = QueryResultRow>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<QueryResult<T>> {
  const text = strings.reduce(
    (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''),
    ''
  );
  return pool.query<T>(text, values);
}

// Let a short-lived process (scripts, the worker's shutdown path) drain the
// pool instead of waiting on the idle timeout.
export async function closeDb(): Promise<void> {
  await pool.end();
}
