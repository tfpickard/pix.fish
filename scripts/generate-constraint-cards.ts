/**
 * Populate constraint_cards with a large, diverse pool across all categories.
 *
 * Strategy (hybrid by default):
 *   1. Sonnet generates a "seed" batch per category (quality anchor).
 *   2. Haiku cheaply expands each category until --target cards per category.
 *
 * Flags:
 *   --target=N       cards to aim for PER CATEGORY (default 100)
 *   --all-sonnet     use Sonnet for ALL generation (higher quality, higher cost)
 *   --dry-run        generate + print, write nothing to the DB
 *   --category=cat   only process one category (can repeat)
 *
 * Usage:
 *   POSTGRES_URL=... ANTHROPIC_API_KEY=... bun scripts/generate-constraint-cards.ts
 *   POSTGRES_URL=... ANTHROPIC_API_KEY=... bun scripts/generate-constraint-cards.ts --all-sonnet
 *   POSTGRES_URL=... ANTHROPIC_API_KEY=... bun scripts/generate-constraint-cards.ts --target=50 --dry-run
 *   POSTGRES_URL=... ANTHROPIC_API_KEY=... bun scripts/generate-constraint-cards.ts --category=mood --target=80
 */

import { db } from '../src/lib/db/client';
import { constraintCards } from '../src/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { loadUserProviderKeys } from '../src/lib/ai';
import { createAnthropicProvider } from '../src/lib/ai/anthropic';
import { getSiteAdminId } from '../src/lib/db/queries/users';
import { getPromptByKey } from '../src/lib/db/queries/prompts';
import {
  CARD_CATEGORIES,
  isCardCategory,
  type CardCategory
} from '../src/lib/db/queries/constraint-cards';

const SONNET_MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Sonnet seeds this many cards per category; Haiku expands the rest.
const N_SONNET_SEED_PER_CATEGORY = 15;
// Haiku batch size per expansion call -- small enough to get clean JSON.
const HAIKU_BATCH_SIZE = 15;

// EM dash variants -- strip defensively even though the prompt forbids them.
const EM_DASH_RE = /—|–/g;

function stripEmDashes(s: string): string {
  return s.replace(EM_DASH_RE, '--');
}

function isValidCardText(text: string): boolean {
  return (
    typeof text === 'string' &&
    text.trim().length > 5 &&
    text.trim().length < 200 &&
    !EM_DASH_RE.test(text)
  );
}

function parseCardArray(raw: string): string[] {
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
  return (parsed as unknown[])
    .filter((item): item is string => typeof item === 'string')
    .map((s) => stripEmDashes(s).trim())
    .filter(isValidCardText);
}

// Deduplicate by normalized text. Returns only items not already in `seen`
// (mutates `seen`).
function dedupeAgainst(candidates: string[], seen: Set<string>): string[] {
  const out: string[] = [];
  for (const text of candidates) {
    const norm = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(text);
  }
  return out;
}

async function fetchExistingCards(category: CardCategory): Promise<string[]> {
  const rows = await db
    .select({ text: constraintCards.text })
    .from(constraintCards)
    .where(and(eq(constraintCards.category, category), eq(constraintCards.active, true)));
  return rows.map((r) => r.text);
}

async function upsertCards(category: CardCategory, cards: string[]): Promise<void> {
  for (const text of cards) {
    await db
      .insert(constraintCards)
      .values({ category, text, active: true })
      .onConflictDoUpdate({
        target: [constraintCards.category, constraintCards.text],
        // Re-activate if it was deactivated; the generator only ever
        // produces new cards, not re-assertions of existing ones.
        set: { active: true }
      });
  }
}

function buildPrompt(
  template: string,
  category: CardCategory,
  existing: string[],
  n: number
): string {
  const existingBlock =
    existing.length === 0
      ? 'No cards exist yet in this category -- generate freely.'
      : existing.map((t) => `- ${t}`).join('\n');

  return template
    .replaceAll('{{category}}', category)
    .replaceAll('{{existing_cards}}', existingBlock)
    .replaceAll('{{n}}', String(n));
}

async function generateBatch(opts: {
  apiKey: string;
  model: string;
  template: string;
  category: CardCategory;
  existing: string[];
  n: number;
}): Promise<string[]> {
  const provider = createAnthropicProvider(opts.apiKey, opts.model);
  if (!provider.text) throw new Error(`Provider ${opts.model} has no text() method`);
  const prompt = buildPrompt(opts.template, opts.category, opts.existing, opts.n);
  let raw: string;
  try {
    raw = await provider.text(prompt);
  } catch (err) {
    console.error(`  [${opts.model}] API call failed for category "${opts.category}":`, err);
    return [];
  }
  return parseCardArray(raw);
}

async function processCategory(opts: {
  apiKey: string;
  category: CardCategory;
  template: string;
  targetPerCategory: number;
  allSonnet: boolean;
  dryRun: boolean;
}): Promise<{ category: CardCategory; newCards: string[] }> {
  const { category, apiKey, template, targetPerCategory, allSonnet } = opts;

  const existing = await fetchExistingCards(category);
  console.log(`\n[${category}] existing: ${existing.length}, target: ${targetPerCategory}`);

  if (existing.length >= targetPerCategory) {
    console.log(`  already at target. skipping.`);
    return { category, newCards: [] };
  }

  const needed = targetPerCategory - existing.length;
  const seen = new Set(existing.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const newCards: string[] = [];

  if (allSonnet) {
    // All-Sonnet: batch in groups of HAIKU_BATCH_SIZE for clean JSON.
    let remaining = needed;
    let context = [...existing];
    while (remaining > 0) {
      const batchN = Math.min(HAIKU_BATCH_SIZE, remaining);
      const raw = await generateBatch({
        apiKey,
        model: SONNET_MODEL,
        template,
        category,
        existing: context,
        n: batchN
      });
      const fresh = dedupeAgainst(raw, seen);
      if (fresh.length === 0) {
        console.warn(`  [sonnet] no unique cards in batch; stopping early.`);
        break;
      }
      newCards.push(...fresh);
      context = [...existing, ...newCards];
      remaining -= fresh.length;
      console.log(`  [sonnet] +${fresh.length} cards; total new: ${newCards.length}`);
    }
  } else {
    // Hybrid: Sonnet seeds, Haiku expands.
    const seedN = Math.min(N_SONNET_SEED_PER_CATEGORY, needed);
    const rawSeed = await generateBatch({
      apiKey,
      model: SONNET_MODEL,
      template,
      category,
      existing,
      n: seedN
    });
    const seed = dedupeAgainst(rawSeed, seen);
    newCards.push(...seed);
    console.log(`  [sonnet] seeded ${seed.length} cards`);

    // Haiku expansion.
    let remaining = needed - newCards.length;
    let context = [...existing, ...newCards];
    while (remaining > 0) {
      const batchN = Math.min(HAIKU_BATCH_SIZE, remaining);
      const raw = await generateBatch({
        apiKey,
        model: HAIKU_MODEL,
        template,
        category,
        existing: context,
        n: batchN
      });
      const fresh = dedupeAgainst(raw, seen);
      if (fresh.length === 0) {
        console.warn(`  [haiku] no unique cards in batch; stopping early.`);
        break;
      }
      newCards.push(...fresh);
      context = [...existing, ...newCards];
      remaining -= fresh.length;
      console.log(`  [haiku] +${fresh.length} cards; total new: ${newCards.length}`);
    }
  }

  return { category, newCards };
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
  const targetPerCategory = targetArg
    ? parseInt(targetArg.split('=')[1] ?? '100', 10)
    : 100;

  // --category can be repeated to process a subset; omit for all categories.
  const requestedCats = args
    .filter((a) => a.startsWith('--category='))
    .map((a) => a.split('=')[1] ?? '')
    .filter(isCardCategory);
  const categories: CardCategory[] =
    requestedCats.length > 0 ? requestedCats : [...CARD_CATEGORIES];

  console.log(
    `generate-constraint-cards: target=${targetPerCategory}/category all-sonnet=${allSonnet} dry-run=${dryRun} categories=[${categories.join(', ')}]`
  );

  // Resolve API key.
  const ownerId = getSiteAdminId();
  const keys = await loadUserProviderKeys(ownerId);
  const apiKey = keys.anthropic;
  if (!apiKey) {
    console.error(
      'No Anthropic API key found. Set ANTHROPIC_API_KEY or configure a provider key for the site admin.'
    );
    process.exit(1);
  }

  // Load the generation prompt from DB (seeded by seed.ts).
  const template = await getPromptByKey('constraint_card_gen');
  if (!template) {
    console.error(
      'prompt "constraint_card_gen" not found in DB. Run "bun run db:seed" first.'
    );
    process.exit(1);
  }

  const results: { category: CardCategory; newCards: string[] }[] = [];

  for (const category of categories) {
    const result = await processCategory({
      apiKey,
      category,
      template,
      targetPerCategory,
      allSonnet,
      dryRun
    });
    results.push(result);
  }

  // Summary.
  const totalNew = results.reduce((acc, r) => acc + r.newCards.length, 0);
  console.log(`\n--- summary ---`);
  for (const { category, newCards } of results) {
    console.log(`  ${category}: +${newCards.length} new cards`);
  }
  console.log(`total new: ${totalNew}`);

  if (dryRun) {
    console.log('\n-- DRY RUN: would upsert these cards --');
    for (const { category, newCards } of results) {
      if (newCards.length === 0) continue;
      console.log(`\n[${category}]`);
      for (const text of newCards) {
        console.log(`  - ${text}`);
      }
    }
    console.log('-- DRY RUN complete; nothing written --');
    process.exit(0);
  }

  console.log('\nwriting to DB...');
  for (const { category, newCards } of results) {
    if (newCards.length === 0) continue;
    await upsertCards(category, newCards);
    console.log(`  [${category}] upserted ${newCards.length} cards`);
  }

  // Final count per category.
  console.log('\nfinal counts in DB:');
  for (const category of categories) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(constraintCards)
      .where(and(eq(constraintCards.category, category), eq(constraintCards.active, true)));
    console.log(`  ${category}: ${row?.n ?? 0}`);
  }

  console.log('done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
