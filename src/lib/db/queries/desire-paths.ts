import { and, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
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
