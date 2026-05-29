/**
 * Populate remix_idioms with a large, diverse, high-quality pool.
 *
 * Strategy (hybrid by default):
 *   1. Sonnet generates ~N_FAMILIES "family" idioms with rich descriptions.
 *   2. Haiku cheaply expands each family into sibling variations until the
 *      total reaches --target (default 1000).
 *
 * Flags:
 *   --target=N       total idiom count to aim for (default 1000)
 *   --all-sonnet     use Sonnet for ALL generation (higher quality, higher cost)
 *   --dry-run        generate + print, write nothing to the DB
 *
 * Usage:
 *   POSTGRES_URL=... ANTHROPIC_API_KEY=... bun scripts/generate-remix-idioms.ts
 *   POSTGRES_URL=... ANTHROPIC_API_KEY=... bun scripts/generate-remix-idioms.ts --all-sonnet
 *   POSTGRES_URL=... ANTHROPIC_API_KEY=... bun scripts/generate-remix-idioms.ts --target=500 --dry-run
 */

import { db } from '../src/lib/db/client';
import { remixIdioms } from '../src/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import { loadUserProviderKeys } from '../src/lib/ai';
import { createAnthropicProvider } from '../src/lib/ai/anthropic';
import { getSiteAdminId } from '../src/lib/db/queries/users';
import { getPromptByKey } from '../src/lib/db/queries/prompts';

// Anthropic model ids pinned per-script so the generation quality is
// predictable regardless of the site-wide ai_config routing.
const SONNET_MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// How many Sonnet "family" idioms to seed before Haiku expands them.
// 30 families * ~33 Haiku siblings each = ~1000 total (matches default target).
const N_SONNET_FAMILIES = 30;
// Haiku batch size per expansion call -- small enough to get clean JSON.
const HAIKU_BATCH_SIZE = 10;

// EM dash variants to strip from generated output. The prompt instructs the
// model not to use them, but we enforce it defensively here too.
const EM_DASH_RE = /—|–|--(?=[^\s])/g;

type RawIdiom = { key: string; label: string; description: string };

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Strip em dashes from a string (defensive -- prompt already instructs models
// not to produce them, but generation is non-deterministic).
function stripEmDashes(s: string): string {
  return s.replace(/—|–/g, '--');
}

function sanitize(idiom: RawIdiom): RawIdiom {
  return {
    key: slugify(idiom.key || idiom.label),
    label: stripEmDashes(idiom.label ?? '').trim(),
    description: stripEmDashes(idiom.description ?? '').trim()
  };
}

function isValid(idiom: RawIdiom): boolean {
  return (
    idiom.key.length > 2 &&
    idiom.label.length > 3 &&
    idiom.description.length > 20 &&
    !EM_DASH_RE.test(idiom.label) &&
    !EM_DASH_RE.test(idiom.description)
  );
}

function parseIdiomArray(raw: string): RawIdiom[] {
  // Strip ```json fences the model sometimes adds despite instructions.
  const body = raw.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, '$1').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Attempt to extract the first [...] block as a fallback.
    const m = body.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as unknown[]).filter(
    (item): item is RawIdiom =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).label === 'string' &&
      typeof (item as Record<string, unknown>).description === 'string'
  );
}

// Deduplicate by normalized key and normalized label. Returns only items not
// already in `seen` (mutates `seen` to track newly added keys/labels).
function dedupeAgainst(
  candidates: RawIdiom[],
  seen: { keys: Set<string>; labels: Set<string> }
): RawIdiom[] {
  const out: RawIdiom[] = [];
  for (const item of candidates) {
    const normLabel = item.label.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.keys.has(item.key) || seen.labels.has(normLabel)) continue;
    seen.keys.add(item.key);
    seen.labels.add(normLabel);
    out.push(item);
  }
  return out;
}

// Resolve a unique key by appending a numeric suffix when a collision occurs.
function uniquifyKey(key: string, usedKeys: Set<string>): string {
  if (!usedKeys.has(key)) return key;
  let i = 2;
  while (usedKeys.has(`${key}-${i}`)) i++;
  return `${key}-${i}`;
}

async function fetchExistingFromDb(): Promise<RawIdiom[]> {
  const rows = await db
    .select({ key: remixIdioms.key, label: remixIdioms.label, description: remixIdioms.description })
    .from(remixIdioms)
    .where(eq(remixIdioms.active, true));
  return rows;
}

async function upsertIdioms(idioms: RawIdiom[]): Promise<void> {
  for (const idiom of idioms) {
    await db
      .insert(remixIdioms)
      .values({
        key: idiom.key,
        label: idiom.label,
        description: idiom.description,
        active: true
      })
      .onConflictDoUpdate({
        target: remixIdioms.key,
        // Refresh label + description on re-run; leave `active` alone so an
        // owner who deactivated an idiom stays deactivated.
        set: { label: idiom.label, description: idiom.description }
      });
  }
}

// Build the {{existing_families}} substitution for the generation prompt.
function formatExisting(existing: RawIdiom[]): string {
  if (existing.length === 0) {
    return 'No idioms exist yet -- the pool is empty, generate freely.';
  }
  const lines = existing.map((i) => `- ${i.label}: ${i.description}`).join('\n');
  return `Already in the pool (do not duplicate):\n${lines}`;
}

async function generateSonnetFamilies(opts: {
  apiKey: string;
  promptTemplate: string;
  existing: RawIdiom[];
  n: number;
  dryRun: boolean;
}): Promise<RawIdiom[]> {
  const provider = createAnthropicProvider(opts.apiKey, SONNET_MODEL);
  if (!provider.text) throw new Error('Sonnet provider has no text() method');

  const prompt = opts.promptTemplate
    .replace('{{existing_families}}', formatExisting(opts.existing))
    .replace('{{n}}', String(opts.n));

  console.log(`  [sonnet] generating ${opts.n} family idioms...`);
  const raw = await provider.text(prompt);
  const parsed = parseIdiomArray(raw);
  console.log(`  [sonnet] got ${parsed.length} raw entries`);
  return parsed;
}

async function generateHaikuExpansion(opts: {
  apiKey: string;
  promptTemplate: string;
  existing: RawIdiom[];
  batchTarget: number;
}): Promise<RawIdiom[]> {
  const provider = createAnthropicProvider(opts.apiKey, HAIKU_MODEL);
  if (!provider.text) throw new Error('Haiku provider has no text() method');

  const prompt = opts.promptTemplate
    .replace('{{existing_families}}', formatExisting(opts.existing))
    .replace('{{n}}', String(opts.batchTarget));

  console.log(`  [haiku] expanding by ${opts.batchTarget} siblings...`);
  let raw: string;
  try {
    raw = await provider.text(prompt);
  } catch (err) {
    console.error('  [haiku] API call failed:', err);
    return [];
  }
  const parsed = parseIdiomArray(raw);
  console.log(`  [haiku] got ${parsed.length} raw entries`);
  return parsed;
}

async function generateAllSonnet(opts: {
  apiKey: string;
  promptTemplate: string;
  existing: RawIdiom[];
  target: number;
}): Promise<RawIdiom[]> {
  // Split into batches of 30 max to stay within a single context window and
  // keep JSON output clean.
  const BATCH = 30;
  const seen = {
    keys: new Set(opts.existing.map((i) => i.key)),
    labels: new Set(opts.existing.map((i) => i.label.toLowerCase().replace(/[^a-z0-9]/g, '')))
  };
  const all: RawIdiom[] = [];
  let remaining = opts.target - opts.existing.length;

  while (remaining > 0) {
    const batchN = Math.min(BATCH, remaining);
    const currentExisting = [...opts.existing, ...all];
    const raw = await generateSonnetFamilies({
      apiKey: opts.apiKey,
      promptTemplate: opts.promptTemplate,
      existing: currentExisting,
      n: batchN,
      dryRun: false
    });
    const sanitized = raw.map(sanitize).filter(isValid);
    const fresh = dedupeAgainst(sanitized, seen);
    all.push(...fresh);
    remaining -= fresh.length;
    console.log(`  [sonnet] accepted ${fresh.length}; total new so far: ${all.length}`);
    if (fresh.length === 0) {
      // Model ran out of ideas or produced duplicates -- stop early.
      console.warn('  [sonnet] no new unique idioms in last batch; stopping early.');
      break;
    }
  }
  return all;
}

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.error('POSTGRES_URL is required.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const allSonnet = args.includes('--all-sonnet');
  const dryRun = args.includes('--dry-run');

  const targetArg = args.find((a) => a.startsWith('--target='));
  const target = targetArg ? parseInt(targetArg.split('=')[1] ?? '1000', 10) : 1000;

  console.log(
    `generate-remix-idioms: target=${target} all-sonnet=${allSonnet} dry-run=${dryRun}`
  );

  // Resolve API key via the site admin's provider keys, falling back to env.
  const ownerId = getSiteAdminId();
  const keys = await loadUserProviderKeys(ownerId);
  const apiKey = keys.anthropic;
  if (!apiKey) {
    console.error(
      'No Anthropic API key found. Set ANTHROPIC_API_KEY or configure a provider key for the site admin.'
    );
    process.exit(1);
  }

  // Load the generation prompt template from DB (seeded by seed.ts).
  const promptTemplate = await getPromptByKey('remix_idiom_gen');
  if (!promptTemplate) {
    console.error(
      'prompt "remix_idiom_gen" not found in DB. Run "bun run db:seed" first.'
    );
    process.exit(1);
  }

  // Start from what is already in the DB so re-runs grow the pool.
  const existing = await fetchExistingFromDb();
  console.log(`existing in DB: ${existing.length} active idioms`);

  if (existing.length >= target) {
    console.log(`Already at or above target (${existing.length} >= ${target}). Nothing to do.`);
    process.exit(0);
  }

  const needed = target - existing.length;
  console.log(`need ${needed} more idioms`);

  const seen = {
    keys: new Set(existing.map((i) => i.key)),
    labels: new Set(existing.map((i) => i.label.toLowerCase().replace(/[^a-z0-9]/g, '')))
  };

  let newIdioms: RawIdiom[] = [];

  if (allSonnet) {
    // Full Sonnet run for maximum quality.
    console.log('strategy: all-sonnet');
    newIdioms = await generateAllSonnet({
      apiKey,
      promptTemplate,
      existing,
      target
    });
  } else {
    // Hybrid: Sonnet seeds families; Haiku expands to target.
    console.log('strategy: hybrid (Sonnet families + Haiku expansion)');

    // Step 1 -- Sonnet families.
    const familyCount = Math.min(N_SONNET_FAMILIES, needed);
    const rawFamilies = await generateSonnetFamilies({
      apiKey,
      promptTemplate,
      existing,
      n: familyCount,
      dryRun
    });
    const families = dedupeAgainst(rawFamilies.map(sanitize).filter(isValid), seen);
    console.log(`  accepted ${families.length} Sonnet families`);
    newIdioms.push(...families);

    // Step 2 -- Haiku expansion in batches until target reached.
    const totalExistingForHaiku = [...existing, ...newIdioms];
    let haikusNeeded = needed - newIdioms.length;

    while (haikusNeeded > 0) {
      const batchN = Math.min(HAIKU_BATCH_SIZE, haikusNeeded);
      const currentContext = [...totalExistingForHaiku, ...newIdioms];
      const rawExpansion = await generateHaikuExpansion({
        apiKey,
        promptTemplate,
        existing: currentContext,
        batchTarget: batchN
      });
      const expansion = dedupeAgainst(rawExpansion.map(sanitize).filter(isValid), seen);
      if (expansion.length === 0) {
        console.warn('  [haiku] no unique idioms in batch; stopping expansion early.');
        break;
      }
      newIdioms.push(...expansion);
      haikusNeeded -= expansion.length;
      console.log(`  [haiku] accepted ${expansion.length}; total new: ${newIdioms.length}`);
    }
  }

  // Assign collision-free keys now that the full set is assembled.
  const usedKeys = new Set(existing.map((i) => i.key));
  const finalIdioms = newIdioms.map((idiom) => {
    const key = uniquifyKey(idiom.key, usedKeys);
    usedKeys.add(key);
    return { ...idiom, key };
  });

  console.log(`\ngenerated ${finalIdioms.length} new idioms.`);

  if (dryRun) {
    console.log('\n-- DRY RUN: would upsert these idioms --');
    for (const idiom of finalIdioms) {
      console.log(`  [${idiom.key}] ${idiom.label}`);
      console.log(`    ${idiom.description}`);
    }
    console.log('-- DRY RUN complete; nothing written --');
    process.exit(0);
  }

  console.log('writing to DB...');
  await upsertIdioms(finalIdioms);

  const totalNow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(remixIdioms)
    .where(eq(remixIdioms.active, true));
  console.log(`done. active idioms in DB: ${totalNow[0]?.n ?? '?'}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
