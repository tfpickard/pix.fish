import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NsfwMode } from '@/lib/nsfw';
import { db } from '../client';
import { imageAttention, images } from '../schema';
import { decayed, ATTENTION_HALF_LIFE_MS } from '../../attention';

// Query helpers for the image_attention table (anonymous, decaying dwell
// telemetry). See src/lib/attention.ts for the decay math and privacy notes.

// Half-life expressed in seconds for SQL (Postgres interval math is easier in
// seconds than ms). Kept derived from the single source of truth in
// attention.ts so the read-time and write-time decay can never diverge.
const HALF_LIFE_SECONDS = ATTENTION_HALF_LIFE_MS / 1000;

// bumpAttention(): atomically accumulate decayed attention for many images.
//
// Concurrency / lost-update safety: this is a single upsert statement, so the
// read-decay-add-write happens inside one row lock held by Postgres for the
// duration of the statement. We do NOT read the value into JS and write it
// back (that classic pattern loses concurrent increments). On conflict we
// compute the new value entirely in SQL:
//
//   new_value = old_value * 0.5 ^ (age_seconds / half_life) + increment
//
// where age_seconds is measured against the row's existing last_updated_at.
// Two concurrent bumps each take the row lock in turn; the second one sees the
// first one's committed value and timestamp, decays from there, and adds its
// own increment. No increment is lost. last_updated_at is stamped to now() so
// the next decay is measured from this write. The insert branch seeds a
// brand-new row at the raw increment (nothing to decay from). `excluded.value`
// is this insert's increment; the image_attention.* refs are the prior row.
//
// Substrate 1: `lifetime` rides alongside in the same statement. Unlike `value`
// it is NEVER decayed -- on conflict we add the raw increment, so it is a
// monotonic sum of all dwell weight this image has ever received (the signal
// erosion reads). The insert branch seeds it at the increment too.
export async function bumpAttention(
  increments: { imageId: number; increment: number }[]
): Promise<void> {
  const rows = increments.filter((r) => r.increment > 0);
  if (rows.length === 0) return;

  await db
    .insert(imageAttention)
    .values(rows.map((r) => ({ imageId: r.imageId, value: r.increment, lifetime: r.increment })))
    .onConflictDoUpdate({
      target: imageAttention.imageId,
      set: {
        value: sql`${imageAttention.value} * power(0.5, extract(epoch from (now() - ${imageAttention.lastUpdatedAt})) / ${HALF_LIFE_SECONDS}) + excluded.value`,
        lifetime: sql`${imageAttention.lifetime} + excluded.value`,
        lastUpdatedAt: sql`now()`
      }
    });
}

// getDecayedAttentionMap(): read decayed attention for a set of image ids.
//
// Decay is applied here at read time (mirroring bumpAttention's SQL), so the
// map reflects values as of "now" without any cron. Returns a Map keyed by
// imageId; ids with no row (or a fully-decayed-to-zero value) are simply
// absent, which downstream code treats as "no attention" (no bias). Decay is
// computed in JS via decayed() rather than SQL so the exact same function the
// rest of the app (and feat/alive) uses governs the read path.
export async function getDecayedAttentionMap(
  imageIds: number[]
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (imageIds.length === 0) return out;

  const dbRows = await db
    .select({
      imageId: imageAttention.imageId,
      value: imageAttention.value,
      lastUpdatedAt: imageAttention.lastUpdatedAt
    })
    .from(imageAttention)
    .where(inArray(imageAttention.imageId, imageIds));

  const now = Date.now();
  for (const r of dbRows) {
    const d = decayed(r.value, r.lastUpdatedAt.getTime(), now);
    if (d > 0) out.set(r.imageId, d);
  }
  return out;
}

// getLifetimeAttentionMap(): read the raw, un-decayed lifetime handling total
// for a set of image ids. This is the erosion signal -- how much a specimen has
// ever been handled, independent of recency. Unlike getDecayedAttentionMap it
// applies NO decay: the stored value is already monotonic. Ids with no row (or
// a zero total) are absent from the map, treated downstream as "unhandled".
export async function getLifetimeAttentionMap(
  imageIds: number[]
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (imageIds.length === 0) return out;

  const dbRows = await db
    .select({ imageId: imageAttention.imageId, lifetime: imageAttention.lifetime })
    .from(imageAttention)
    .where(inArray(imageAttention.imageId, imageIds));

  for (const r of dbRows) {
    if (r.lifetime > 0) out.set(r.imageId, r.lifetime);
  }
  return out;
}

// AND-composable visibility clause for a leaderboard join on the images table.
// Mirrors the public gallery's gate: NSFW is filtered per `nsfwMode`, and rows
// pulled from circulation (archived) or hidden outside it (basement) never
// surface on a "most looked-at" board. Kept local (rather than importing
// nsfwPredicate from ./images) so this module has no dependency edge back to
// the images query file, which already imports from here.
function boardVisibility(nsfwMode: NsfwMode) {
  const conds = [isNull(images.archivedAt), eq(images.basement, false)];
  if (nsfwMode === 'hide') conds.push(eq(images.isNsfw, false));
  else if (nsfwMode === 'only') conds.push(eq(images.isNsfw, true));
  return and(...conds);
}

export type DwellMode = 'hot' | 'lifetime';
export type RankedImage = { imageId: number; slug: string; score: number };

// getTopAttention(): the most-dwelt images, ranked descending. `mode='hot'`
// ranks by the live decayed value (what is drawing eyes lately); `lifetime`
// ranks by the monotonic handling total (what has been looked at most, ever).
// Visibility mirrors the public gallery via boardVisibility(). image_attention
// is one row per attended image (bounded by the corpus), so -- exactly like
// getTopPaths -- we scan it, apply the shared decay() in JS for 'hot' (no SQL
// decay approximation, no cron), rank, and slice. slug rides along so callers
// that only need a label (admin bars) skip a second round-trip; callers that
// render cards hydrate the returned imageIds.
export async function getTopAttention(opts: {
  mode: DwellMode;
  limit?: number;
  nsfwMode?: NsfwMode;
}): Promise<RankedImage[]> {
  const limit = Math.max(0, Math.trunc(opts.limit ?? 24));
  if (limit === 0) return [];

  const rows = await db
    .select({
      imageId: imageAttention.imageId,
      slug: images.slug,
      value: imageAttention.value,
      lifetime: imageAttention.lifetime,
      lastUpdatedAt: imageAttention.lastUpdatedAt
    })
    .from(imageAttention)
    .innerJoin(images, eq(images.id, imageAttention.imageId))
    .where(boardVisibility(opts.nsfwMode ?? 'hide'));

  const now = Date.now();
  return rows
    .map((r) => ({
      imageId: r.imageId,
      slug: r.slug,
      score: opts.mode === 'hot' ? decayed(r.value, r.lastUpdatedAt.getTime(), now) : r.lifetime
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export type AttentionStanding = {
  // Live decayed dwell ("hot") and the monotonic lifetime handling total.
  hot: number;
  lifetime: number;
  // 1-based rank of this image by hot among all currently-attended images, or
  // null if it has no live attention. `tracked` is the size of that ranked set.
  rank: number | null;
  tracked: number;
};

// getAttentionStanding(): the per-image detail readout. Returns this image's
// live/lifetime dwell plus its rank by live attention across the whole board.
// Ranking is visibility-agnostic (this is the record's own detail context, and
// a rank is a position, not content) and scans the small image_attention table
// once -- cheap relative to the other per-detail queries.
export async function getAttentionStanding(imageId: number): Promise<AttentionStanding> {
  const rows = await db
    .select({
      imageId: imageAttention.imageId,
      value: imageAttention.value,
      lifetime: imageAttention.lifetime,
      lastUpdatedAt: imageAttention.lastUpdatedAt
    })
    .from(imageAttention);

  const now = Date.now();
  const mine = rows.find((r) => r.imageId === imageId);
  const ranked = rows
    .map((r) => ({ imageId: r.imageId, hot: decayed(r.value, r.lastUpdatedAt.getTime(), now) }))
    .filter((r) => r.hot > 0)
    .sort((a, b) => b.hot - a.hot);
  const idx = ranked.findIndex((r) => r.imageId === imageId);

  return {
    hot: mine ? decayed(mine.value, mine.lastUpdatedAt.getTime(), now) : 0,
    lifetime: mine?.lifetime ?? 0,
    rank: idx >= 0 ? idx + 1 : null,
    tracked: ranked.length
  };
}
