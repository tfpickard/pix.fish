/**
 * Dry-run the outbound X dispatch and print the would-be post. This is the
 * caption review tool: the tone contract is the heart of the feature, so it
 * needs to be judged on real output before the live switch is ever discussed.
 *
 *   bun scripts/dispatch-dryrun.ts                 # today's real trends, 1 draft
 *   bun scripts/dispatch-dryrun.ts --count 3       # 3 drafts, different specimens
 *   bun scripts/dispatch-dryrun.ts --drift         # force the drift variant
 *   bun scripts/dispatch-dryrun.ts --mock jaguar   # fixed brand-fail trend
 *   bun scripts/dispatch-dryrun.ts --mock tragedy  # prove the safety gate skips
 *
 * Read-only: it never writes an event and never claims the day, so running it
 * cannot consume or block the scheduled dispatch. (The equivalent inside the app
 * is the "run a review dispatch" button on /admin/dispatch, which DOES write an
 * event, under a suffixed claim key.)
 *
 * Requires POSTGRES_URL plus the site admin's Anthropic and OpenAI keys, same as
 * the job itself.
 */
import { getEmbedder } from '../src/lib/ai';
import { loadAiConfig } from '../src/lib/ai/loadConfig';
import { loadUserProviderKeys } from '../src/lib/ai/keys';
import { getSiteAdminId } from '../src/lib/db/queries/users';
import { listDispatchCandidates, listDispatchedImageIds } from '../src/lib/db/queries/dispatch';
import {
  BAND_MAX_DISTANCE,
  BAND_MIN_DISTANCE,
  MAX_POOL_CANDIDATES,
  WIDE_BAND_MAX_DISTANCE,
  WIDE_BAND_MIN_DISTANCE,
  captionCharBudget
} from '../src/lib/dispatch/config';
import { generateCaption } from '../src/lib/dispatch/caption';
import { hitsDenylist, screenTrends } from '../src/lib/dispatch/safety';
import { pickSpecimen } from '../src/lib/dispatch/select';
import { googleTrendsSource, hashtagFor, trendText } from '../src/lib/dispatch/trends';
import { driftForDate, utcDateKey } from '../src/lib/dispatch/schedule';
import type { Trend } from '../src/lib/dispatch/types';

// Fixtures. `jaguar` is the reference brand-fail trend the tone contract was
// drafted against; `tragedy` exists to demonstrate that the gate fails closed.
const MOCKS: Record<string, Trend> = {
  jaguar: {
    topic: 'Jaguar rebrand',
    source: 'mock',
    headlines: [
      { title: "Jaguar's new logo and 'Copy Nothing' ad draw mass mockery", source: 'The Verge' },
      { title: 'Car brand pauses sales as rebrand backlash grows', source: 'Autocar' }
    ],
    approxTraffic: '200,000+'
  },
  tragedy: {
    topic: 'Aldridge',
    source: 'mock',
    headlines: [
      { title: 'Former striker Aldridge dies at 54 after short illness', source: 'BBC' },
      { title: 'Tributes pour in from across the league', source: 'Sky Sports' }
    ],
    approxTraffic: '500,000+'
  }
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : null;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.error('POSTGRES_URL not set. Aborting.');
    process.exit(1);
  }

  const count = Math.min(Math.max(Number(arg('count') ?? 1) || 1, 1), 10);
  const mockName = arg('mock');
  const forceDrift = flag('drift');
  const dateKey = utcDateKey(new Date());
  const charBudget = captionCharBudget();

  // ---- trend ---------------------------------------------------------------
  let trends: Trend[];
  if (mockName) {
    const mock = MOCKS[mockName];
    if (!mock) {
      console.error(`unknown mock "${mockName}". known: ${Object.keys(MOCKS).join(', ')}`);
      process.exit(1);
    }
    trends = [mock];
    console.log(`using mock trend "${mockName}"`);
  } else {
    trends = await googleTrendsSource().fetchTrends();
    console.log(`fetched ${trends.length} trends from google-trends`);
  }
  if (trends.length === 0) {
    console.log('\nNO POST: trend source returned nothing (reason: no_trends)');
    return;
  }

  // ---- safety gate ---------------------------------------------------------
  console.log('\n--- safety gate ---');
  for (const t of trends) {
    const hit = hitsDenylist(t);
    if (hit) console.log(`  denylist  ${t.topic}  (matched "${hit}")`);
  }
  const screened = await screenTrends(trends);
  if (!screened.ok) {
    console.log(`\nNO POST: classifier error (reason: classifier_error) -- ${screened.error}`);
    return;
  }
  console.log(
    `  ${trends.length} fetched, ${screened.deniedByList} denied by list, ${screened.screened} classified, ${screened.cleared.length} cleared`
  );
  for (const c of screened.cleared) {
    console.log(
      `  cleared   ${c.trend.topic}  [${c.verdict.category}, ${c.verdict.confidence}] ${c.verdict.reason}`
    );
  }
  if (screened.cleared.length === 0) {
    console.log('\nNO POST: nothing cleared the safety gate (reason: no_safe_trend)');
    console.log('This is a correct outcome, not a failure.');
    return;
  }

  const chosen = screened.cleared[0]!;
  const hashtag = hashtagFor(chosen.trend.topic);

  // ---- specimen pool -------------------------------------------------------
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(getSiteAdminId());
  const embedder = getEmbedder(cfg, keys);
  if (!embedder) {
    console.log('\nNO POST: no embeddings key (reason: no_provider_key)');
    return;
  }
  const vec = await embedder.embed(trendText(chosen.trend));
  const excludeImageIds = await listDispatchedImageIds();
  let candidates = await listDispatchCandidates({
    vec,
    embedProvider: embedder.name,
    embedModel: embedder.model,
    minDistance: BAND_MIN_DISTANCE,
    maxDistance: BAND_MAX_DISTANCE,
    limit: MAX_POOL_CANDIDATES,
    excludeImageIds
  });
  let band = `${BAND_MIN_DISTANCE}-${BAND_MAX_DISTANCE}`;
  if (candidates.length === 0) {
    candidates = await listDispatchCandidates({
      vec,
      embedProvider: embedder.name,
      embedModel: embedder.model,
      minDistance: WIDE_BAND_MIN_DISTANCE,
      maxDistance: WIDE_BAND_MAX_DISTANCE,
      limit: MAX_POOL_CANDIDATES,
      excludeImageIds
    });
    band = `${WIDE_BAND_MIN_DISTANCE}-${WIDE_BAND_MAX_DISTANCE} (widened)`;
  }
  console.log(`\n--- specimens ---\n  ${candidates.length} in band ${band}`);
  if (candidates.length === 0) {
    console.log('\nNO POST: no specimen in the similarity band (reason: no_specimen)');
    return;
  }

  // ---- drafts --------------------------------------------------------------
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    const pool = candidates.filter((c) => !used.has(c.imageId));
    if (pool.length === 0) break;
    const specimen = pickSpecimen(pool, { seed: `${dateKey}:${chosen.trend.topic}:${i}`, now: new Date() });
    if (!specimen) break;
    used.add(specimen.imageId);

    // Vary the variant across drafts so a review run shows both registers rather
    // than N samples of whichever one today happens to be.
    const drift = forceDrift || (count > 1 ? i === count - 1 : driftForDate(dateKey));
    const result = await generateCaption({ trend: chosen.trend, specimen, charBudget, drift });

    console.log(`\n=== draft ${i + 1}/${count} ${drift ? '(drift variant)' : '(standard)'} ===`);
    console.log(`  specimen : ${specimen.imageId} /u/${specimen.handle}/${specimen.slug}`);
    console.log(`  cosine   : ${specimen.distance.toFixed(3)}${specimen.isNsfw ? '  [NSFW]' : ''}`);
    console.log(`  intake   : ${specimen.intakeRecord.replace(/\s+/g, ' ').slice(0, 160)}...`);
    console.log(`  trend    : ${chosen.trend.topic} -> ${hashtag}`);
    if (!result.ok) {
      console.log(`  REJECTED : ${result.reason} (reason: generation_failed)`);
      continue;
    }
    console.log(`  model    : ${result.model}`);
    console.log(`  length   : ${result.caption.length}/${charBudget} chars`);
    console.log(`\n  ${result.caption}\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
