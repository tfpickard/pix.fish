import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { desirePaths, type DesirePath } from '../schema';

// Query helpers for desire_paths -- the promoted routes visitors have worn into
// the graph. The desire.promote job writes these; /paths and /path/[slug] read
// them. See src/lib/desire/assemble.ts for how a route's node sequence is
// derived, and src/lib/db/schema.ts for column semantics.

export async function getDesirePathBySig(edgeSig: string): Promise<DesirePath | undefined> {
  const [row] = await db.select().from(desirePaths).where(eq(desirePaths.edgeSig, edgeSig)).limit(1);
  return row;
}

// Insert a newly-promoted route. May throw on a slug or edge_sig unique
// violation; the caller regenerates the slug and retries (edge_sig collisions
// mean the route already exists and should have gone down the refresh path).
export async function insertDesirePath(row: {
  slug: string;
  edgeSig: string;
  nodeIds: number[];
  caption: string | null;
  provider: string | null;
  model: string | null;
  strength: number;
  lifetime: number;
  lastWalkedAt: Date | null;
}): Promise<DesirePath> {
  const [inserted] = await db.insert(desirePaths).values(row).returning();
  return inserted!;
}

// Refresh an existing route's live metrics and un-retire it (a corridor worn
// again comes back). Slug, caption, and node sequence are preserved.
export async function refreshDesirePath(
  edgeSig: string,
  metrics: { strength: number; lifetime: number; lastWalkedAt: Date | null }
): Promise<void> {
  await db
    .update(desirePaths)
    .set({
      strength: metrics.strength,
      lifetime: metrics.lifetime,
      lastWalkedAt: metrics.lastWalkedAt,
      retiredAt: null
    })
    .where(eq(desirePaths.edgeSig, edgeSig));
}

// Batched existence lookup for a run's candidate signatures. The promote job
// checks every qualifying corridor, which at scale is hundreds of round-trips
// if done one-by-one (a nightly run has to finish inside the worker budget), so
// it asks once and reads the answers out of the returned Map.
export async function getDesirePathsBySigs(sigs: string[]): Promise<Map<string, DesirePath>> {
  const out = new Map<string, DesirePath>();
  const unique = [...new Set(sigs)];
  if (unique.length === 0) return out;

  // Chunked so a very large qualifying set can't blow past parameter limits.
  for (let i = 0; i < unique.length; i += SIG_CHUNK) {
    const chunk = unique.slice(i, i + SIG_CHUNK);
    const rows = await db.select().from(desirePaths).where(inArray(desirePaths.edgeSig, chunk));
    for (const r of rows) out.set(r.edgeSig, r);
  }
  return out;
}

const SIG_CHUNK = 200;

// Bulk metric refresh. Same semantics as refreshDesirePath (un-retires a
// corridor worn again) but folded into one statement per chunk via a VALUES
// join, so refreshing every qualifying route costs a handful of round-trips
// instead of one per route.
export async function refreshDesirePathsBulk(
  updates: { edgeSig: string; strength: number; lifetime: number; lastWalkedAt: Date | null }[]
): Promise<number> {
  if (updates.length === 0) return 0;
  let touched = 0;

  for (let i = 0; i < updates.length; i += SIG_CHUNK) {
    const chunk = updates.slice(i, i + SIG_CHUNK);
    const values = sql.join(
      chunk.map(
        (u) =>
          sql`(${u.edgeSig}, ${u.strength}::real, ${u.lifetime}::real, ${
            u.lastWalkedAt ? sql`${u.lastWalkedAt.toISOString()}::timestamptz` : sql`null::timestamptz`
          })`
      ),
      sql`, `
    );
    const res = await db.execute(sql`
      UPDATE desire_paths AS d
      SET strength = v.strength,
          lifetime = v.lifetime,
          last_walked_at = v.last_walked_at,
          retired_at = NULL
      FROM (VALUES ${values}) AS v(edge_sig, strength, lifetime, last_walked_at)
      WHERE d.edge_sig = v.edge_sig
    `);
    touched += res.rowCount ?? chunk.length;
  }
  return touched;
}

// Name a route that was filed without one (its first captioning attempt failed
// or ran out of the per-run budget). Only fills a NULL caption, so a later run
// can never overwrite a name that already stuck.
export async function setDesirePathCaptionIfNull(
  edgeSig: string,
  caption: string,
  provider: string | null,
  model: string | null
): Promise<void> {
  await db
    .update(desirePaths)
    .set({ caption, provider, model })
    .where(and(eq(desirePaths.edgeSig, edgeSig), isNull(desirePaths.caption)));
}

// Every active route, for lifecycle checks that must consider routes the
// current traffic sample didn't surface (see edge-verified retirement).
export async function listActiveDesirePaths(): Promise<DesirePath[]> {
  return db.select().from(desirePaths).where(isNull(desirePaths.retiredAt));
}

// Retire an explicit set of routes. Used by edge-verified retirement, which
// decides per-route whether a corridor's own edges have actually decayed --
// rather than inferring death from absence in one greedy partition.
export async function retireDesirePathsBySigs(sigs: string[], now: Date): Promise<number> {
  const unique = [...new Set(sigs)];
  if (unique.length === 0) return 0;
  let retired = 0;
  for (let i = 0; i < unique.length; i += SIG_CHUNK) {
    const chunk = unique.slice(i, i + SIG_CHUNK);
    const rows = await db
      .update(desirePaths)
      .set({ retiredAt: now })
      .where(and(isNull(desirePaths.retiredAt), inArray(desirePaths.edgeSig, chunk)))
      .returning({ id: desirePaths.id });
    retired += rows.length;
  }
  return retired;
}

// Retire (hide, never delete) every active route not re-promoted this run --
// its corridor has overgrown. Passing an empty keep-set retires all actives.
export async function retireDesirePathsExcept(keepSigs: string[], now: Date): Promise<number> {
  const activeAndStale = keepSigs.length
    ? and(isNull(desirePaths.retiredAt), notInArray(desirePaths.edgeSig, keepSigs))
    : isNull(desirePaths.retiredAt);
  const rows = await db
    .update(desirePaths)
    .set({ retiredAt: now })
    .where(activeAndStale)
    .returning({ id: desirePaths.id });
  return rows.length;
}

// Public listing: active (non-retired) routes, strongest first.
export async function listDesirePaths(opts: { includeRetired?: boolean; limit?: number } = {}): Promise<
  DesirePath[]
> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const q = db.select().from(desirePaths);
  const filtered = opts.includeRetired ? q : q.where(isNull(desirePaths.retiredAt));
  return filtered.orderBy(desc(desirePaths.strength)).limit(limit);
}

export async function getActiveDesirePathBySlug(slug: string): Promise<DesirePath | undefined> {
  const [row] = await db
    .select()
    .from(desirePaths)
    .where(and(eq(desirePaths.slug, slug), isNull(desirePaths.retiredAt)))
    .limit(1);
  return row;
}

export async function countDesirePaths(): Promise<{ active: number; retired: number }> {
  const [row] = await db
    .select({
      active: sql<number>`count(*) filter (where ${desirePaths.retiredAt} is null)::int`,
      retired: sql<number>`count(*) filter (where ${desirePaths.retiredAt} is not null)::int`
    })
    .from(desirePaths);
  return { active: row?.active ?? 0, retired: row?.retired ?? 0 };
}
