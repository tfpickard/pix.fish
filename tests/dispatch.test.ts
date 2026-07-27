import { afterEach, describe, expect, test } from 'bun:test';
import {
  BAND_MAX_DISTANCE,
  BAND_MIN_DISTANCE,
  CAPTION_MAX_TOKENS,
  CAPTION_TIMEOUT_MS,
  DEFAULT_CAPTION_CHAR_BUDGET,
  MAX_HASHTAGS,
  SAFETY_MAX_TOKENS,
  SAFETY_TIMEOUT_MS,
  UPSTREAM_DEADLINE_BUDGET_MS,
  WORKER_JOB_TIMEOUT_MS,
  captionCharBudget,
  dispatchLiveEnabled
} from '../src/lib/dispatch/config';
import { hitsDenylist, parseVerdicts, verdictClears } from '../src/lib/dispatch/safety';
import { hashtagFor, parseGoogleTrendsRss, trendText } from '../src/lib/dispatch/trends';
import {
  DRIFT_PROBABILITY,
  dispatchMinuteForDate,
  driftForDate,
  isDispatchDue,
  utcDateKey
} from '../src/lib/dispatch/schedule';
import { pickSpecimen, recencyWeight } from '../src/lib/dispatch/select';
import { extractHashtags, overlapsIntakeRecord, validateCaption } from '../src/lib/dispatch/caption';
import { dedupeKey } from '../src/lib/universe/events';
import { SKIP_REASON, type SpecimenCandidate, type Trend } from '../src/lib/dispatch/types';

// Pure, infra-free tests in the style of tests/pisci-cost.test.ts. The guards
// this feature rests on -- fail-closed safety, one post per day, bounded tokens,
// no retry -- must be ENFORCED, not merely configured, so they are asserted here.

const SAFE_TREND: Trend = {
  topic: 'Jaguar rebrand',
  source: 'google-trends',
  headlines: [
    { title: "Jaguar's new logo draws mass mockery online", source: 'The Verge' },
    { title: 'Car brand doubles down on Copy Nothing campaign', source: 'Adweek' }
  ],
  approxTraffic: '50,000+'
};

const TRAGEDY_TREND: Trend = {
  topic: 'Aldridge',
  source: 'google-trends',
  headlines: [
    { title: 'Former striker Aldridge dies at 54 after short illness', source: 'BBC' },
    { title: 'Tributes pour in for the late forward', source: 'Sky' }
  ],
  approxTraffic: '200,000+'
};

describe('cost guards', () => {
  test('LLM output budgets are tight, not just present', () => {
    expect(SAFETY_MAX_TOKENS).toBeLessThanOrEqual(1000);
    expect(CAPTION_MAX_TOKENS).toBeLessThanOrEqual(600);
    expect(SAFETY_MAX_TOKENS).toBeGreaterThan(0);
    expect(CAPTION_MAX_TOKENS).toBeGreaterThan(0);
  });

  // Both upstream deadlines must sit inside the worker's 50s per-job timeout for
  // 'x.dispatch', with room for the trend fetch and the embed alongside them.
  test('per-call deadlines fit inside the job timeout', () => {
    expect(SAFETY_TIMEOUT_MS + CAPTION_TIMEOUT_MS).toBeLessThan(50_000);
  });

  test('at most two hashtags are ever allowed', () => {
    expect(MAX_HASHTAGS).toBeLessThanOrEqual(2);
  });
});

describe('caption char budget', () => {
  const original = process.env.X_DISPATCH_CHAR_BUDGET;
  afterEach(() => {
    if (original === undefined) delete process.env.X_DISPATCH_CHAR_BUDGET;
    else process.env.X_DISPATCH_CHAR_BUDGET = original;
  });

  test('defaults to the non-Premium X limit', () => {
    delete process.env.X_DISPATCH_CHAR_BUDGET;
    expect(captionCharBudget()).toBe(DEFAULT_CAPTION_CHAR_BUDGET);
    expect(DEFAULT_CAPTION_CHAR_BUDGET).toBe(280);
  });

  test('honours a raised budget', () => {
    process.env.X_DISPATCH_CHAR_BUDGET = '600';
    expect(captionCharBudget()).toBe(600);
  });

  test('clamps an absurd budget and ignores nonsense', () => {
    process.env.X_DISPATCH_CHAR_BUDGET = '999999';
    expect(captionCharBudget()).toBe(4000);
    process.env.X_DISPATCH_CHAR_BUDGET = 'banana';
    expect(captionCharBudget()).toBe(DEFAULT_CAPTION_CHAR_BUDGET);
  });
});

describe('live switch defaults to off', () => {
  const original = process.env.X_DISPATCH_LIVE;
  afterEach(() => {
    if (original === undefined) delete process.env.X_DISPATCH_LIVE;
    else process.env.X_DISPATCH_LIVE = original;
  });

  test('unset means dry run', () => {
    delete process.env.X_DISPATCH_LIVE;
    expect(dispatchLiveEnabled()).toBe(false);
  });

  test('only the exact string "true" enables it', () => {
    process.env.X_DISPATCH_LIVE = 'yes';
    expect(dispatchLiveEnabled()).toBe(false);
    process.env.X_DISPATCH_LIVE = '1';
    expect(dispatchLiveEnabled()).toBe(false);
    process.env.X_DISPATCH_LIVE = 'true';
    expect(dispatchLiveEnabled()).toBe(true);
  });
});

describe('safety gate fires on tragedy before any model call', () => {
  test('a death trend is caught by the deterministic denylist', () => {
    expect(hitsDenylist(TRAGEDY_TREND)).not.toBeNull();
  });

  test('the denylist reads headlines, not only the topic', () => {
    // "Aldridge" alone is innocuous; only the coverage reveals what it is about.
    expect(hitsDenylist({ ...TRAGEDY_TREND, headlines: [] })).toBeNull();
    expect(hitsDenylist(TRAGEDY_TREND)).not.toBeNull();
  });

  test('a genuinely dumb trend passes the list', () => {
    expect(hitsDenylist(SAFE_TREND)).toBeNull();
  });

  test.each([
    ['shooting at a mall', 'shooting'],
    ['Magnitude 6 earthquake strikes coast', 'earthquake'],
    ['Star found dead at home', 'found dead'],
    ['Jury reaches verdict in trial', 'verdict']
  ])('catches %s', (headline) => {
    expect(
      hitsDenylist({ topic: 'x', source: 's', headlines: [{ title: headline, source: null }], approxTraffic: null })
    ).not.toBeNull();
  });
});

describe('verdict acceptance is fail-closed', () => {
  const base = { topic: 'Jaguar rebrand', safe: true, category: 'brand-fail', confidence: 'high', reason: '' } as const;

  test('clears only a high-confidence safe verdict in an allowed category', () => {
    expect(verdictClears({ ...base })).toBe(true);
  });

  test('medium confidence is a rejection -- uncertainty means no post', () => {
    expect(verdictClears({ ...base, confidence: 'medium' })).toBe(false);
    expect(verdictClears({ ...base, confidence: 'low' })).toBe(false);
  });

  test('an unrecognised category is a rejection', () => {
    expect(verdictClears({ ...base, category: 'politics' })).toBe(false);
    expect(verdictClears({ ...base, category: 'unclear' })).toBe(false);
    expect(verdictClears({ ...base, category: 'unsafe' })).toBe(false);
  });

  test('safe must be explicitly true', () => {
    expect(verdictClears({ ...base, safe: false })).toBe(false);
  });
});

describe('classifier response parsing', () => {
  const trends = [SAFE_TREND];

  test('unparseable output yields null, which the handler turns into a skip', () => {
    expect(parseVerdicts('I think these are mostly fine!', trends)).toBeNull();
    expect(parseVerdicts('', trends)).toBeNull();
    expect(parseVerdicts('{"safe":true}', trends)).toBeNull(); // object, not array
  });

  test('tolerates a code fence', () => {
    const out = parseVerdicts(
      '```json\n[{"index":0,"safe":true,"category":"brand-fail","confidence":"high","reason":"logo mockery"}]\n```',
      trends
    );
    expect(out).not.toBeNull();
    expect(out![0]!.safe).toBe(true);
    expect(out![0]!.topic).toBe('Jaguar rebrand');
  });

  test('a missing safe flag reads as unsafe, and a missing confidence as low', () => {
    const out = parseVerdicts('[{"index":0,"category":"brand-fail"}]', trends);
    expect(out![0]!.safe).toBe(false);
    expect(out![0]!.confidence).toBe('low');
    expect(verdictClears(out![0]!)).toBe(false);
  });

  test('an entry with no index is dropped rather than bound positionally', () => {
    // Positional fallback was a gate bypass: a safe verdict meant for one topic
    // would attach to a different, unclassified one and clear it for posting.
    const two = [SAFE_TREND, { ...SAFE_TREND, topic: 'Second Topic' }];
    const out = parseVerdicts('[{"safe":true,"category":"meme","confidence":"high"}]', two);
    expect(out).toEqual([]);
  });

  test('a duplicate index is dropped rather than rebinding a trend', () => {
    const two = [SAFE_TREND, { ...SAFE_TREND, topic: 'Second Topic' }];
    const out = parseVerdicts(
      '[{"index":0,"safe":false,"category":"unsafe","confidence":"high"},' +
        '{"index":0,"safe":true,"category":"meme","confidence":"high"}]',
      two
    );
    expect(out!.length).toBe(1);
    expect(out![0]!.safe).toBe(false);
  });

  test('a reordered response still binds each verdict to its own topic', () => {
    const two = [SAFE_TREND, { ...SAFE_TREND, topic: 'Second Topic' }];
    const out = parseVerdicts(
      '[{"index":1,"safe":true,"category":"meme","confidence":"high"},' +
        '{"index":0,"safe":false,"category":"unsafe","confidence":"high"}]',
      two
    );
    expect(out!.find((v) => v.topic === 'Second Topic')!.safe).toBe(true);
    expect(out!.find((v) => v.topic === 'Jaguar rebrand')!.safe).toBe(false);
  });

  test('a non-integer index is dropped', () => {
    expect(parseVerdicts('[{"index":0.5,"safe":true,"category":"meme","confidence":"high"}]', trends)).toEqual([]);
    expect(parseVerdicts('[{"index":"0","safe":true,"category":"meme","confidence":"high"}]', trends)).toEqual([]);
  });

  test('a verdict for a topic that was not submitted is dropped', () => {
    const out = parseVerdicts('[{"index":9,"safe":true,"category":"meme","confidence":"high"}]', trends);
    expect(out).toEqual([]);
  });
});

describe('google trends rss parsing', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>jaguar rebrand</title>
      <ht:approx_traffic>50,000+</ht:approx_traffic>
      <ht:news_item>
        <ht:news_item_title>Jaguar&apos;s new logo draws mockery</ht:news_item_title>
        <ht:news_item_source>The Verge</ht:news_item_source>
      </ht:news_item>
      <ht:news_item>
        <ht:news_item_title><![CDATA[Brand doubles down]]></ht:news_item_title>
        <ht:news_item_source>Adweek</ht:news_item_source>
      </ht:news_item>
    </item>
    <item><title>second topic</title></item>
  </channel></rss>`;

  test('pulls topic, traffic, and headlines', () => {
    const trends = parseGoogleTrendsRss(xml);
    expect(trends.length).toBe(2);
    expect(trends[0]!.topic).toBe('jaguar rebrand');
    expect(trends[0]!.approxTraffic).toBe('50,000+');
    expect(trends[0]!.headlines.map((h) => h.title)).toEqual([
      "Jaguar's new logo draws mockery",
      'Brand doubles down'
    ]);
  });

  test('an item with no coverage still parses, with no headlines', () => {
    expect(parseGoogleTrendsRss(xml)[1]!.headlines).toEqual([]);
  });

  test('garbage input yields no trends rather than throwing', () => {
    expect(parseGoogleTrendsRss('<html>nope</html>')).toEqual([]);
    expect(parseGoogleTrendsRss('')).toEqual([]);
  });

  test('trend text leads with the topic so it dominates the embedding', () => {
    expect(trendText(SAFE_TREND).startsWith('Jaguar rebrand')).toBe(true);
  });
});

describe('hashtag derivation', () => {
  test('TitleCases a multi-word topic', () => {
    expect(hashtagFor('jaguar rebrand')).toBe('#JaguarRebrand');
  });

  test('strips punctuation X will not carry', () => {
    expect(hashtagFor("Jaguar's rebrand!")).toBe('#JaguarsRebrand');
  });

  test('refuses a topic that would make an invalid tag', () => {
    expect(hashtagFor('2026 something')).toBe('');
    expect(hashtagFor('!!!')).toBe('');
  });
});

describe('one dispatch per day is structural', () => {
  test('the day key is the dedupe key, so a second claim collides', () => {
    expect(dedupeKey.dispatchDay('2026-07-26')).toBe(dedupeKey.dispatchDay('2026-07-26'));
    expect(dedupeKey.dispatchDay('2026-07-26')).not.toBe(dedupeKey.dispatchDay('2026-07-27'));
  });

  test('a review run claims a distinct slot and cannot consume the real day', () => {
    expect(dedupeKey.dispatchDay('2026-07-26', 'manual:123')).not.toBe(
      dedupeKey.dispatchDay('2026-07-26')
    );
  });

  test('one claim yields at most one outcome', () => {
    const slot = dedupeKey.dispatchDay('2026-07-26');
    expect(dedupeKey.dispatchOutcome(slot)).toBe(dedupeKey.dispatchOutcome(slot));
  });
});

describe('upstream deadlines leave headroom under the worker budget', () => {
  // The deadlines run sequentially and withTimeout does NOT cancel the work it
  // rejects, so if their sum reaches the worker's per-job budget a merely-slow
  // successful run gets failed from outside the handler -- after the claim, with
  // no outcome event, and the handler's own catch cannot see it. Assert the
  // arithmetic instead of trusting whoever last edited a constant.
  test('the sum of upstream deadlines is well under the job timeout', () => {
    expect(UPSTREAM_DEADLINE_BUDGET_MS).toBeLessThanOrEqual(WORKER_JOB_TIMEOUT_MS * 0.7);
  });

  test('enough is left for the embedding call and the candidate queries', () => {
    expect(WORKER_JOB_TIMEOUT_MS - UPSTREAM_DEADLINE_BUDGET_MS).toBeGreaterThanOrEqual(15_000);
  });
});

describe('every claimed day gets an outcome', () => {
  // The claim is what makes a day un-runnable again, so a claimed day with no
  // dispatch.sent / dispatch.skipped on the log is a silent no-post -- invisible
  // at /admin/dispatch and un-retryable, because the cron sees the claim and
  // declines. The handler therefore wraps everything after the claim and maps an
  // unexpected throw onto this reason rather than letting the job die.
  test('there is a reason code for an unexpected failure', () => {
    expect(SKIP_REASON.InternalError).toBe('internal_error');
  });

  test('reason codes are unique, non-empty, and machine-groupable', () => {
    const codes = Object.values(SKIP_REASON);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[a-z][a-z_]*$/);
  });

  test('the outcome key is derived from the claim slot, so one claim yields one outcome', () => {
    const day = dedupeKey.dispatchDay('2026-07-26');
    const manual = dedupeKey.dispatchDay('2026-07-26', 'manual:1');
    // Same slot -> same outcome key, whichever path writes it (sent or skipped).
    expect(dedupeKey.dispatchOutcome(day)).toBe(dedupeKey.dispatchOutcome(day));
    // A review run's outcome cannot overwrite the real day's outcome.
    expect(dedupeKey.dispatchOutcome(manual)).not.toBe(dedupeKey.dispatchOutcome(day));
  });
});

describe('schedule jitter', () => {
  const days = Array.from({ length: 400 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
  );

  test('is deterministic per date', () => {
    for (const d of days.slice(0, 20)) {
      expect(dispatchMinuteForDate(d)).toBe(dispatchMinuteForDate(d));
    }
  });

  test('never leaves the day, so the claim key always matches the fire date', () => {
    for (const d of days) {
      const m = dispatchMinuteForDate(d);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1439);
    }
  });

  test('stays inside the cron window the schedule actually covers', () => {
    // vercel.json fires 14:09-23:39 UTC; a target outside that would never fire.
    for (const d of days) {
      expect(dispatchMinuteForDate(d)).toBeGreaterThanOrEqual(14 * 60);
      expect(dispatchMinuteForDate(d)).toBeLessThanOrEqual(23 * 60);
    }
  });

  test('most days land within an hour of the base, a few wander further', () => {
    const base = 18 * 60 + 17;
    const offsets = days.map((d) => Math.abs(dispatchMinuteForDate(d) - base));
    const typical = offsets.filter((o) => o <= 60).length;
    const wide = offsets.filter((o) => o > 60).length;
    expect(typical / offsets.length).toBeGreaterThan(0.8);
    expect(wide).toBeGreaterThan(0); // the tail must actually happen
    expect(Math.max(...offsets)).toBeLessThanOrEqual(240);
  });

  test('a tick before the target does not fire, one after does', () => {
    const day = '2026-07-26';
    const minute = dispatchMinuteForDate(day);
    const at = (m: number) => new Date(Date.UTC(2026, 6, 26, Math.floor(m / 60), m % 60));
    expect(isDispatchDue(at(minute - 1))).toBe(false);
    expect(isDispatchDue(at(minute))).toBe(true);
    expect(isDispatchDue(at(minute + 30))).toBe(true);
  });

  test('utcDateKey is the UTC calendar day', () => {
    expect(utcDateKey(new Date('2026-07-26T23:59:00Z'))).toBe('2026-07-26');
    expect(utcDateKey(new Date('2026-07-27T00:01:00Z'))).toBe('2026-07-27');
  });
});

describe('drift variant is a deterministic minority', () => {
  const days = Array.from({ length: 500 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
  );

  test('same day always decides the same way', () => {
    expect(driftForDate('2026-07-26')).toBe(driftForDate('2026-07-26'));
  });

  test('fires on a minority of days, near the configured rate', () => {
    const rate = days.filter(driftForDate).length / days.length;
    expect(rate).toBeGreaterThan(0.1);
    expect(rate).toBeLessThan(0.45);
    expect(DRIFT_PROBABILITY).toBeLessThan(0.5);
  });
});

describe('specimen selection', () => {
  const now = new Date('2026-07-26T12:00:00Z');
  const candidate = (imageId: number, daysOld: number): SpecimenCandidate => ({
    imageId,
    slug: `s${imageId}`,
    handle: 'owner',
    blobUrl: `https://blob/${imageId}`,
    mime: 'image/jpeg',
    isNsfw: false,
    uploadedAt: new Date(now.getTime() - daysOld * 86_400_000),
    intakeRecord: 'a record',
    distance: 0.6
  });

  test('the band excludes both a match and pure noise', () => {
    expect(BAND_MIN_DISTANCE).toBeGreaterThan(0.3);
    expect(BAND_MAX_DISTANCE).toBeLessThan(1.0);
    expect(BAND_MIN_DISTANCE).toBeLessThan(BAND_MAX_DISTANCE);
  });

  test('recency weight decays but never reaches zero', () => {
    expect(recencyWeight(now, now)).toBeCloseTo(1, 5);
    expect(recencyWeight(new Date(now.getTime() - 45 * 86_400_000), now)).toBeLessThan(0.4);
    expect(recencyWeight(new Date(now.getTime() - 900 * 86_400_000), now)).toBeGreaterThan(0);
  });

  test('an empty pool selects nothing rather than throwing', () => {
    expect(pickSpecimen([], { seed: 'x', now })).toBeNull();
  });

  test('the same seed always picks the same specimen', () => {
    const pool = [candidate(1, 0), candidate(2, 100), candidate(3, 300)];
    const a = pickSpecimen(pool, { seed: '2026-07-26:Jaguar', now });
    const b = pickSpecimen(pool, { seed: '2026-07-26:Jaguar', now });
    expect(a!.imageId).toBe(b!.imageId);
  });

  test('the old corpus stays eligible, it is only down-weighted', () => {
    // A pool of nothing but very old images must still produce a pick.
    const oldOnly = [candidate(10, 800), candidate(11, 1200)];
    expect(pickSpecimen(oldOnly, { seed: 'x', now })).not.toBeNull();
  });

  test('recent images win the majority of seeds', () => {
    const pool = [candidate(1, 1), candidate(2, 400)];
    let recent = 0;
    for (let i = 0; i < 200; i++) {
      if (pickSpecimen(pool, { seed: `seed-${i}`, now })!.imageId === 1) recent++;
    }
    expect(recent).toBeGreaterThan(150);
  });
});

describe('caption validation enforces the tone contract', () => {
  const opts = { hashtag: '#JaguarRebrand', charBudget: 280, intakeRecord: 'A heron in a ditch.' };

  test('accepts a clean deadpan notice', () => {
    const raw =
      'Specimen 3312: a heron, standing in eleven centimetres of runoff behind a tyre depot. Reviewed against the elevated term and confirmed to be a different animal entirely. No amendment required. #JaguarRebrand';
    const out = validateCaption(raw, opts);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.hashtags).toEqual(['#JaguarRebrand']);
      expect(out.caption.length).toBeLessThanOrEqual(280);
    }
  });

  test('strips emoji rather than posting them', () => {
    const out = validateCaption('Specimen 3312 has been reviewed 🦈 and filed. #JaguarRebrand', opts);
    expect(out.ok).toBe(true);
    if (out.ok) expect(/[\u{1F000}-\u{1FAFF}]/u.test(out.caption)).toBe(false);
  });

  test('converts em dashes to the project double hyphen', () => {
    const out = validateCaption('Specimen 3312 — filed and closed. #JaguarRebrand', opts);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.caption).not.toContain('—');
  });

  test('rejects a caption missing the required hashtag', () => {
    const out = validateCaption('Specimen 3312 has been filed.', opts);
    expect(out.ok).toBe(false);
  });

  test('trims a hashtag wall down to the ceiling', () => {
    const out = validateCaption(
      'Specimen 3312 has been filed and closed. #JaguarRebrand #Archive #Records #Filing',
      opts
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.hashtags.length).toBeLessThanOrEqual(MAX_HASHTAGS);
      expect(out.hashtags).toContain('#JaguarRebrand');
    }
  });

  test('rejects prose trailing after the hashtag', () => {
    // Phase 2 posts this verbatim, so a tag buried mid-sentence is the wrong
    // artifact even though a presence check would pass it.
    const out = validateCaption('Specimen 3312 #JaguarRebrand has been filed and closed.', opts);
    expect(out.ok).toBe(false);
  });

  test('a permitted second hashtag may follow the required one', () => {
    const out = validateCaption('Specimen 3312 has been filed. #JaguarRebrand #Archive', opts);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.hashtags).toContain('#JaguarRebrand');
  });

  test('re-checks intake overlap on the trimmed result, not just the original', () => {
    // The opening sentence restates the record; the long unrelated tail dilutes
    // the ratio on the full text, and trimming then keeps exactly that opening.
    const intake = 'A heron standing in eleven centimetres of runoff behind a depot.';
    // Each filler sentence is long enough that none of them fits alongside the
    // opening inside the 280-char budget, so trimming keeps the opening alone --
    // which is the restatement. On the full text the filler dilutes the ratio.
    const filler =
      'Filler clause concerning unrelated quarterly cabinet inventory matters, '.repeat(4) +
      'concluded.';
    const long = `${intake} ${filler.repeat(1)} ${filler} #JaguarRebrand`;
    const out = validateCaption(long, { ...opts, intakeRecord: intake });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('restates the intake record');
  });

  test('rejects a caption that just restates the intake record', () => {
    const out = validateCaption('A heron standing in a ditch. #JaguarRebrand', {
      ...opts,
      intakeRecord: 'A heron standing in a ditch, photographed at dusk.'
    });
    expect(out.ok).toBe(false);
  });

  test('trims an over-budget caption at a sentence boundary, hashtag intact', () => {
    const long = `${'Specimen 3312 has been reviewed and filed by the duty clerk. '.repeat(8)}#JaguarRebrand`;
    const out = validateCaption(long, opts);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.caption.length).toBeLessThanOrEqual(280);
      expect(out.caption.endsWith('#JaguarRebrand')).toBe(true);
    }
  });

  test('fails closed when nothing can be trimmed to fit', () => {
    const out = validateCaption(`${'word '.repeat(200)}#JaguarRebrand`, opts);
    expect(out.ok).toBe(false);
  });

  test('an empty or hashtag-only response is rejected', () => {
    expect(validateCaption('', opts).ok).toBe(false);
    expect(validateCaption('#JaguarRebrand', opts).ok).toBe(false);
  });

  test('overlap detection ignores short filler words', () => {
    expect(overlapsIntakeRecord('the a of in on', 'entirely different content here')).toBe(false);
  });

  test('hashtag extraction handles unicode topics', () => {
    expect(extractHashtags('filed #Café2 and #b')).toEqual(['#Café2', '#b']);
  });
});
