import { desc, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { events, type UniverseEvent } from '../schema';
import { EVENT_TYPE } from '@/lib/universe/events';
import { LIVE_ALLOW_NSFW, LIVE_STILL_MIMES } from '@/lib/dispatch/config';
import type { SpecimenCandidate } from '@/lib/dispatch/types';

// Data layer for the outbound X dispatch. Query construction stays here, out of
// the job handler, per the project rule against inline Drizzle in handlers.

// Candidates inside a cosine-distance band from the trend vector. The band is the
// whole selection idea: nearer than the floor and the specimen is genuinely about
// the trend, which kills the joke; past the ceiling there is no thread at all.
//
// The whole corpus is eligible (recency is a weighting preference applied by the
// caller, not a filter) and NSFW rows are included by explicit product decision.
//
// Two exclusions are NOT preferences and must stay:
//   archived_at -- archived rows keep their embeddings, so without the gate a
//     deleted image could be posted to a public account.
//   basement    -- basement is an access GATE, not a visibility preference. The
//     schema calls these rows server-gated and every public reader excludes them
//     (random.ts, path-hydrate.ts, attention.ts, path-traffic.ts, stats.ts).
//     Posting one to X would publish a blob the site itself refuses to serve
//     without an unlock, which is a worse leak than any NSFW question -- the
//     NSFW inclusion here was a deliberate product call, this would not be.
//
// `intake_record` prefers the clerk's dossier, falls back to the canonical
// caption (slug-source first, else lowest variant), and finally the slug.
export async function listDispatchCandidates(params: {
  vec: number[];
  // Provenance of the vector above. Cosine distance is only meaningful within one
  // embedding space, so rows written by a different provider/model are excluded
  // rather than silently compared. Without this, changing the embeddings model
  // before the corpus is reprocessed lets stale rows drift into the configured
  // band and the "middle distance" selection becomes arbitrary -- which would look
  // like a working dispatch producing nonsense pairings, not like a failure.
  embedProvider: string;
  embedModel: string;
  // Seeds the sample below. Same seed plus same corpus yields the same pool, so a
  // deliberate replay of a given day reproduces.
  sampleSeed: string;
  minDistance: number;
  maxDistance: number;
  limit: number;
  excludeImageIds: number[];
  // Restrict to rows a LIVE post may use. This has to happen in SQL, before the
  // LIMIT, not in the caller afterwards: the limit takes the first N of a seeded
  // sample, so filtering after it means a band whose first N happen to be
  // ineligible reports an empty pool while eligible rows sit just past the cut.
  // The widening pass cannot rescue that either -- it re-samples a superset with
  // the same seed, so the same rows stay in front.
  //
  // The predicate below is BUILT from the same constants liveEligible() uses, not
  // written out again alongside it. It has to exist in SQL to be correct here and
  // in TS to re-check an image that changed after selection, but sharing the
  // constants means the policy has one home even though it has two call sites.
  liveOnly?: boolean;
}): Promise<SpecimenCandidate[]> {
  const vecLiteral = `[${params.vec.join(',')}]`;
  // Built FROM the policy constants rather than restating them. The previous
  // version hardcoded the NSFW half, so flipping LIVE_ALLOW_NSFW -- a documented
  // switch -- changed liveEligible() and left this query excluding the very rows
  // the switch exists to admit. Two expressions of one rule had already drifted
  // within a day of my writing a comment acknowledging the risk. Deriving both
  // from the same constants is the actual fix; the comment was not.
  const mimeList = sql.join(
    [...LIVE_STILL_MIMES].map((m) => sql`${m}`),
    sql`, `
  );
  const nsfwFilter = LIVE_ALLOW_NSFW
    ? sql``
    : sql`AND i.is_nsfw = false AND i.nsfw_source = 'auto'`;
  const liveFilter = params.liveOnly
    ? sql`${nsfwFilter} AND lower(i.mime) IN (${mimeList})`
    : sql``;
  const exclude =
    params.excludeImageIds.length > 0
      ? sql`AND i.id NOT IN (${sql.join(
          params.excludeImageIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      : sql``;

  const res = await db.execute<{
    id: number;
    slug: string;
    handle: string;
    blob_url: string;
    mime: string | null;
    is_nsfw: boolean;
    nsfw_source: string | null;
    uploaded_at: string;
    distance: number;
    intake_record: string;
  }>(sql`
    SELECT
      i.id,
      i.slug,
      u.handle,
      i.blob_url,
      i.mime,
      i.is_nsfw,
      i.nsfw_source,
      i.uploaded_at,
      e.vec <=> ${vecLiteral}::vector AS distance,
      COALESCE(NULLIF(s.current_dossier, ''), NULLIF(c.text, ''), i.slug) AS intake_record
    FROM embeddings e
    JOIN images i ON i.id = e.image_id
    JOIN users u ON u.id = i.owner_id
    LEFT JOIN specimens s ON s.image_id = i.id
    LEFT JOIN LATERAL (
      SELECT text FROM captions
      WHERE image_id = i.id
      ORDER BY is_slug_source DESC, variant ASC
      LIMIT 1
    ) c ON true
    WHERE e.kind = 'caption'
      AND e.subject_type = 'image'
      AND e.provider = ${params.embedProvider}
      AND e.model = ${params.embedModel}
      AND i.archived_at IS NULL
      AND i.basement = false
      AND (e.vec <=> ${vecLiteral}::vector) BETWEEN ${params.minDistance} AND ${params.maxDistance}
      ${exclude}
      ${liveFilter}
    -- Sample the band, do not skim its near edge. Ordering by distance before the
    -- LIMIT made only the N nearest rows reachable, so every farther specimen had
    -- zero chance of selection no matter its recency weight -- and the bias grows
    -- with the corpus. It also worked against the point of the band: the near edge
    -- is where the specimen is most nearly ABOUT the trend, which is the outcome
    -- the middle-distance rule exists to avoid.
    --
    -- md5 over the id plus a caller-supplied seed gives a uniform pseudo-random
    -- order that is stable for a given day, so replays reproduce. Distance is
    -- still returned; it is recorded on the event and reviewed, it just no longer
    -- decides who is eligible.
    ORDER BY md5(i.id::text || ${params.sampleSeed})
    LIMIT ${Math.min(Math.max(Math.trunc(params.limit), 1), 2000)}
  `);

  return res.rows.map((r) => ({
    imageId: Number(r.id),
    slug: r.slug,
    handle: r.handle,
    blobUrl: r.blob_url,
    mime: r.mime,
    isNsfw: Boolean(r.is_nsfw),
    nsfwSource: r.nsfw_source,
    uploadedAt: new Date(r.uploaded_at),
    intakeRecord: r.intake_record,
    distance: Number(r.distance)
  }));
}

// Is this image still postable RIGHT NOW? The candidate query already excluded
// archived and basement rows, but that read happens before caption generation and
// the media upload -- tens of seconds during which an admin can archive the very
// image about to go out. Archiving leaves the blob intact, so nothing downstream
// would notice. Re-read immediately before the side effect.
// Returns the CURRENT publishability inputs, not a verdict: the caller applies
// liveEligible() so one predicate governs both selection and this last look.
// Returns null when the row has vanished.
export async function currentPostState(imageId: number): Promise<{
  gated: boolean;
  isNsfw: boolean;
  nsfwSource: string | null;
  mime: string | null;
} | null> {
  const res = await db.execute<{
    gated: boolean;
    is_nsfw: boolean;
    nsfw_source: string | null;
    mime: string | null;
  }>(sql`
    SELECT
      (archived_at IS NOT NULL OR basement = true) AS gated,
      is_nsfw, nsfw_source, mime
    FROM images WHERE id = ${imageId}
  `);
  const row = res.rows?.[0];
  if (!row) return null;
  return {
    gated: Boolean(row.gated),
    isNsfw: Boolean(row.is_nsfw),
    nsfwSource: row.nsfw_source,
    mime: row.mime
  };
}

// Image ids already spent on a dispatch. Read straight off the append-only log
// rather than a projection: the log is the record, and a specimen should not be
// sent twice even after a projection rebuild.
//
// Review samples are deliberately NOT counted. A manual run writes the same
// dispatch.sent type, so counting it here would let reviewing the feature
// permanently burn a specimen -- changing what the scheduled run picks, or
// skipping it outright with no_specimen when the sample took the only candidate
// in the band. /api/admin/dispatch promises a review never consumes the day, and
// the suffixed claim slot alone does not deliver that; this is the other half.
//
// The predicate is written to stay correct through phase 2, where a manual run
// CAN post for real: anything with a postId was actually sent and is excluded
// regardless of trigger. A missing trigger counts as scheduled, which is the
// conservative reading for any row written before the field existed.
export async function listDispatchedImageIds(): Promise<number[]> {
  const res = await db.execute<{ image_id: number }>(sql`
    SELECT DISTINCT (payload->>'imageId')::int AS image_id
    FROM events
    WHERE payload->>'imageId' IS NOT NULL
      AND (
        (
          type = ${EVENT_TYPE.DispatchSent}
          AND (
            payload->>'trigger' IS DISTINCT FROM 'manual'
            OR payload->>'postId' IS NOT NULL
          )
        )
        -- Attempts count unconditionally, including manual ones. The attempt row
        -- is only ever written on a LIVE run immediately before the X call, so it
        -- means "this specimen may already be public" -- which is exactly the
        -- state that must never be re-selected. Reading only dispatch.sent left a
        -- window where a successful post whose outcome write then failed would
        -- leave the specimen eligible and let it go out a second time.
        -- An attempt means "this specimen may already be public". It burns the
        -- specimen UNLESS the same slot also recorded a definite rejection --
        -- a readable non-2xx from X, where nothing was published. Without that
        -- correlation a routine 403 (an access token minted before write
        -- permission, say) would quietly consume one good specimen per day while
        -- posting nothing. post_indeterminate deliberately does NOT rescue the
        -- specimen: not knowing is exactly when to stay conservative.
        --
        -- Correlated by SLOT, not by date. subject_id is only the UTC date, and
        -- manual runs are unlimited, so one date holds many independent runs. On
        -- a date-only match any one run's definite rejection would rescue every
        -- other run's specimen -- including one whose post may be public. That is
        -- the precise case this predicate exists to prevent, so matching on the
        -- date turns the guard into its own counterexample.
        OR (
          type = ${EVENT_TYPE.DispatchAttempted}
          AND NOT EXISTS (
            SELECT 1 FROM events o
            WHERE o.type = ${EVENT_TYPE.DispatchSkipped}
              AND o.subject_type = 'dispatch'
              AND o.payload->>'slotKey' = events.payload->>'slotKey'
              AND o.payload->>'reason' = 'post_failed'
          )
        )
      )
  `);
  return res.rows.map((r) => Number(r.image_id)).filter((n) => Number.isFinite(n));
}

// Recent dispatch OUTCOMES for /admin/dispatch, newest first.
//
// Deliberately excludes dispatch.claimed. The page never renders claims, so
// fetching them spent half of every window on rows that were then discarded --
// a 60-row read covered only ~30 runs, and a day with a review run alongside the
// scheduled one burned through it faster still. Claims remain on the log; they
// are the once-per-day lock, not review material.
// `offset` makes the whole history reachable a page at a time. Without it the
// clamped limit was a hard ceiling rather than a page size: everything past the
// first 200 outcomes was unreachable from the only review surface, and
// countDispatchOutcomes just reported that hidden rows existed.
export async function listRecentDispatchEvents(
  limit = 60,
  offset = 0
): Promise<UniverseEvent[]> {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const off = Math.max(Math.trunc(offset), 0);
  return db
    .select()
    .from(events)
    // Attempts are included alongside outcomes. They are written before the X
    // call on live runs, so an attempt with no matching sent is the only trace
    // left when a post succeeds and its outcome write dies -- exactly the case an
    // operator most needs to see, and the case the page could not previously show
    // at all.
    .where(
      inArray(events.type, [
        EVENT_TYPE.DispatchAttempted,
        EVENT_TYPE.DispatchSent,
        EVENT_TYPE.DispatchSkipped
      ])
    )
    .orderBy(desc(events.id))
    .limit(lim)
    .offset(off);
}

// Total outcomes on file, so the review page can say when it is showing a window
// onto a longer history rather than the whole thing.
export async function countDispatchOutcomes(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM events
    WHERE type IN (${EVENT_TYPE.DispatchAttempted}, ${EVENT_TYPE.DispatchSent}, ${EVENT_TYPE.DispatchSkipped})
  `);
  return Number(res.rows?.[0]?.n ?? 0);
}

// Whether a given UTC date already has a dispatch outcome on file. Used by the
// admin page to show today's state; the hard once-per-day guarantee is enforced
// by the claim event's unique dedupe key, not by this read.
export async function dispatchOutcomeForDate(dateKey: string): Promise<UniverseEvent | null> {
  const [row] = await db
    .select()
    .from(events)
    .where(
      sql`${events.subjectType} = 'dispatch' AND ${events.subjectId} = ${dateKey} AND ${events.type} <> ${EVENT_TYPE.DispatchClaimed}`
    )
    .orderBy(desc(events.id))
    .limit(1);
  return row ?? null;
}

// Whether a LIVE post was already attempted on a given UTC date, by any trigger.
//
// dispatch.attempted is written only on the live path, immediately before the one
// call that can publish, so its presence is exactly "something was posted, or may
// have been" -- which is the question the cron needs answered. A dispatch.sent
// always follows an attempt, so checking attempts alone covers both.
//
// This backs the rule that a manual post suppresses the day's automatic one. It
// is advisory: the structural cron-vs-cron cap is still the day-claim's unique
// dedupe key. A manual run racing the cron tick could in principle let both
// through, which is within tolerance -- manual posting is deliberately unlimited,
// so the failure mode is one extra post on a day the operator was posting by hand
// anyway.
export async function livePostAttemptedOnDate(dateKey: string): Promise<boolean> {
  const res = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM events
    WHERE subject_type = 'dispatch'
      AND subject_id = ${dateKey}
      AND type = ${EVENT_TYPE.DispatchAttempted}
      -- An attempt that X definitely rejected published nothing, so it must not
      -- stand down the day's scheduled post. A manual run refused with a 403 --
      -- an access token minted before write permission was granted, say -- is the
      -- likely case, and the operator fixing the credentials should still get
      -- their scheduled dispatch rather than silently losing the day to a post
      -- that never existed. post_indeterminate still suppresses: not knowing is
      -- when to stay conservative.
      AND NOT EXISTS (
        SELECT 1 FROM events o
        WHERE o.type = ${EVENT_TYPE.DispatchSkipped}
          AND o.subject_type = 'dispatch'
          AND o.payload->>'slotKey' = events.payload->>'slotKey'
          AND o.payload->>'reason' = 'post_failed'
      )
  `);
  return Number(res.rows?.[0]?.n ?? 0) > 0;
}

// Every attempt with no outcome of its own, newest first, regardless of where it
// falls in the paginated log.
//
// These are the rows that say a post MAY be public with nothing recording it, so
// they cannot be a by-product of the page the operator happens to be looking at.
// Deriving them by filtering the loaded page meant an attempt aged off the first
// 60 events took the warning with it -- the audit surface quietly dropping its
// single most important claim, and dropping it precisely as the incident got
// older and easier to forget.
//
// Bounded anyway: this should be empty in normal operation, and a log with more
// than LIMIT unresolved attempts has a systemic problem that a longer list will
// not help anyone read.
export async function listUnresolvedAttempts(limit = 50): Promise<UniverseEvent[]> {
  return db
    .select()
    .from(events)
    .where(
      sql`${events.type} = ${EVENT_TYPE.DispatchAttempted}
        AND NOT EXISTS (
          SELECT 1 FROM events o
          WHERE o.subject_type = 'dispatch'
            AND o.type IN (${EVENT_TYPE.DispatchSent}, ${EVENT_TYPE.DispatchSkipped})
            AND o.payload->>'slotKey' = ${events.payload}->>'slotKey'
        )`
    )
    .orderBy(desc(events.id))
    .limit(limit);
}

// How many publish attempts for this draft have already ended DEFINITELY -- a
// failure where nothing was published.
//
// This is the generation behind the approval key, and it is what makes approval
// retryable without making it repeatable. Keying approval on the draft alone
// made a single failure permanent: a run that declined for a stale credential,
// a blob 404, or a spent budget still left the approval committed, so every
// later click enqueued a job that returned immediately. The button stayed, the
// draft stayed unpublished, and nothing an operator could do would change that.
//
// post_indeterminate deliberately does not count. If the post MAY be public,
// re-approving must stay blocked.
export async function publishAttemptGeneration(draftEventId: number): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM events
    WHERE type = ${EVENT_TYPE.DispatchSkipped}
      AND subject_type = 'dispatch'
      AND (payload->>'draftEventId')::int = ${draftEventId}
      AND payload->>'reason' <> 'post_indeterminate'
  `);
  return Number(res.rows?.[0]?.n ?? 0);
}

// Draft ids that have already been published, or whose publication may have
// happened. The review page uses this to stop offering an approve button that
// can only no-op, and the approve route to refuse before enqueueing.
//
// The draft row itself cannot answer this: the log is append-only, so publishing
// writes a NEW dispatch.sent and the draft keeps postId=null forever. Reading
// the draft alone is exactly why the button persisted after a successful post.
export async function publishedDraftIds(): Promise<number[]> {
  const res = await db.execute<{ id: number }>(sql`
    SELECT DISTINCT (payload->>'approvedFromDraft')::int AS id
    FROM events
    WHERE subject_type = 'dispatch'
      AND payload->>'approvedFromDraft' IS NOT NULL
    UNION
    SELECT DISTINCT (payload->>'draftEventId')::int AS id
    FROM events
    WHERE type = ${EVENT_TYPE.DispatchSkipped}
      AND subject_type = 'dispatch'
      AND payload->>'reason' = 'post_indeterminate'
      AND payload->>'draftEventId' IS NOT NULL
  `);
  return res.rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
}

// Trend topics this account has already ridden recently, newest first.
//
// The feed is not a stream of novelty. Google Trends carries perennials --
// "stock market news today" and its relatives are there most days -- and the
// safety gate reliably clears them precisely because they are low-stakes, so a
// deterministic pick lands on the same topic run after run. That reads as a bot
// with one subject, which is worse than a bot with no subject.
//
// Read from the outcome events rather than a separate table: they already record
// every topic the account has attached itself to, drafts included, and a draft
// that was reviewed and discarded still means the operator has seen that topic.
export async function recentTrendTopics(limit = 12): Promise<string[]> {
  const res = await db.execute<{ topic: string }>(sql`
    SELECT payload->>'trendTopic' AS topic
    FROM events
    WHERE subject_type = 'dispatch'
      AND type IN (${EVENT_TYPE.DispatchSent}, ${EVENT_TYPE.DispatchSkipped})
      AND payload->>'trendTopic' IS NOT NULL
    ORDER BY id DESC
    LIMIT ${Math.min(Math.max(Math.trunc(limit), 1), 200)}
  `);
  return res.rows.map((r) => r.topic).filter((t): t is string => Boolean(t));
}

// How many times this specimen has been attempted and DEFINITELY rejected --
// a readable 4xx from X, where nothing was published.
//
// This is the generation counter behind dedupeKey.dispatchAttempt. It has to be
// derived rather than stored: two concurrent runs must compute the SAME value so
// their attempt keys collide and only one proceeds, and any value derived from
// the same committed history satisfies that. A per-run counter would not.
//
// post_indeterminate deliberately does not count. A specimen whose post may be
// public must never come back, so its generation stays put and its key stays
// taken.
export async function definiteFailureGeneration(imageId: number): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM events a
    WHERE a.type = ${EVENT_TYPE.DispatchAttempted}
      AND (a.payload->>'imageId')::int = ${imageId}
      AND EXISTS (
        SELECT 1 FROM events o
        WHERE o.type = ${EVENT_TYPE.DispatchSkipped}
          AND o.subject_type = 'dispatch'
          AND o.payload->>'slotKey' = a.payload->>'slotKey'
          AND o.payload->>'reason' = 'post_failed'
      )
  `);
  return Number(res.rows?.[0]?.n ?? 0);
}

export async function countDispatchEventsOfType(type: string): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM events WHERE type = ${type}`
  );
  return Number(res.rows?.[0]?.n ?? 0);
}
