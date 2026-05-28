/**
 * Mine a caption grammar from the site admin's image corpus.
 *
 *   bun scripts/derive-grammar.ts            # POS-only pass
 *   bun scripts/derive-grammar.ts --llm      # plus an LLM cleanup pass
 *
 * Approach:
 *   1. Read every caption + the first sentence of every description for the
 *      site admin's images. We focus on the first sentence of descriptions
 *      because the corpus's "voice" is densest there; later sentences drift
 *      into narrative.
 *   2. POS-tag each text with compromise. Replace consecutive #Noun, #Verb,
 *      and #Adjective spans with [noun]/[verb]/[adjective] placeholders.
 *      The raw matched text gets pooled as a filler under the corresponding
 *      slot type. Anything else (determiners, prepositions, punctuation) is
 *      kept verbatim so the template reads like the source.
 *   3. Frequency-count templates and fillers.
 *   4. With --llm: send the top templates and top fillers to the captions
 *      provider via provider.text() and ask for a curated filler list per
 *      slot (drops nonsense, dedupes near-duplicates, suggests friendlier
 *      slot names). Falls back to raw POS slots if the LLM call fails.
 *   5. clearGrammar() then upsert templates + fillers.
 */
import nlp from 'compromise';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/lib/db/client';
import { captions, descriptions, images } from '../src/lib/db/schema';
import { getProvider, loadUserProviderKeys } from '../src/lib/ai';
import { loadAiConfig } from '../src/lib/ai/loadConfig';
import { bulkInsertFillers, bulkInsertSlots, clearGrammar } from '../src/lib/db/queries/grammar';

type SlotType = 'noun' | 'verb' | 'adjective';

const SLOT_TYPES: SlotType[] = ['noun', 'verb', 'adjective'];
// Drop templates that appear only once -- they bloat the artifact without
// adding generative variety. Drop fillers that are too long (likely a parse
// glitch) or that are common-stopword-ish.
const MIN_TEMPLATE_FREQ = 1;
const MAX_FILLER_LEN = 32;
const STOP_FILLERS = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'have', 'has', 'had', 'i', 'a', 'the', 'an', 'it', 'this', 'that', 'these',
  'those', 'something', 'someone'
]);

type Extraction = {
  template: string;
  fillers: { slot: SlotType; text: string }[];
};

function pickSlot(tags: string[]): SlotType | null {
  // Order matters: compromise sometimes tags color words with both
  // `Adjective` and `Color`; we want them to land as adjectives. Adjective
  // wins over verb/noun when present.
  if (tags.includes('Adjective')) return 'adjective';
  if (tags.includes('Verb')) return 'verb';
  if (tags.includes('Noun')) return 'noun';
  return null;
}

function normalizeFiller(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9\- ]+/g, '')
    .trim()
    .toLowerCase();
}

function extractFromText(text: string): Extraction {
  // compromise's .terms().json() returns sentence-like wrappers with nested
  // terms arrays; flatten to a single per-token stream.
  const raw = nlp(text).terms().json() as { terms?: { text: string; tags: string[] }[] }[];
  const terms = raw.flatMap((s) => s.terms ?? []);

  const out: string[] = [];
  const fillers: { slot: SlotType; text: string }[] = [];
  let currentSlot: SlotType | null = null;
  let currentSpan: string[] = [];

  const flush = () => {
    if (currentSlot && currentSpan.length > 0) {
      const filler = normalizeFiller(currentSpan.join(' '));
      if (
        filler &&
        filler.length <= MAX_FILLER_LEN &&
        !STOP_FILLERS.has(filler)
      ) {
        fillers.push({ slot: currentSlot, text: filler });
      }
      out.push(`[${currentSlot}]`);
    } else if (currentSpan.length > 0) {
      out.push(currentSpan.join(' '));
    }
    currentSpan = [];
    currentSlot = null;
  };

  for (const term of terms) {
    const slot = pickSlot(term.tags ?? []);
    const raw = (term.text ?? '').trim();
    if (!raw) continue;
    if (slot === currentSlot) {
      currentSpan.push(raw);
    } else {
      flush();
      currentSlot = slot;
      currentSpan = [raw];
    }
  }
  flush();

  return {
    template: out.join(' ').replace(/\s+/g, ' ').trim(),
    fillers
  };
}

function firstSentence(text: string): string {
  const i = text.search(/[.!?]/);
  if (i < 0) return text;
  return text.slice(0, i + 1);
}

type Counts = Map<string, number>;

function topByCount(counts: Counts, limit: number): { key: string; n: number }[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, n]) => ({ key, n }));
}

async function loadCorpus(ownerId: string): Promise<string[]> {
  const imgs = await db.select({ id: images.id }).from(images).where(eq(images.ownerId, ownerId));
  if (imgs.length === 0) return [];
  const ids = imgs.map((r) => r.id);
  // Locked captions get the same weight as AI ones -- the owner's manual
  // captions are part of the corpus voice we want to mine. Skipping NSFW
  // for now because the user can already opt those out at the gallery
  // level; the grammar artifact should be safe to surface anywhere.
  const [capRows, descRows] = await Promise.all([
    db.select({ text: captions.text }).from(captions).where(inArray(captions.imageId, ids)),
    db
      .select({ text: descriptions.text })
      .from(descriptions)
      .where(inArray(descriptions.imageId, ids))
  ]);
  const out: string[] = [];
  for (const r of capRows) if (r.text) out.push(r.text);
  for (const r of descRows) if (r.text) out.push(firstSentence(r.text));
  return out;
}

type LLMCleanup = {
  slot_names: Record<SlotType, string>;
  fillers: Record<string, string[]>;
};

async function llmCleanup(opts: {
  ownerId: string;
  topTemplates: string[];
  fillersBySlot: Record<SlotType, string[]>;
}): Promise<LLMCleanup | null> {
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(opts.ownerId);
  const provider = getProvider('captions', cfg, keys);
  if (!provider?.text) {
    console.log('  (no text-capable captions provider for owner; skipping LLM pass)');
    return null;
  }
  const prompt = `You are tightening up a procedurally-derived caption grammar.

The grammar was extracted from a personal image gallery's captions and descriptions. Slots are typed by part of speech: "noun", "verb", "adjective". The owner wants:
  1) a more evocative name per slot type (still lowercase snake_case, one or two words). The names should fit how the slots are USED across the templates below.
  2) a curated filler list per renamed slot. Drop fillers that are stopwords, parsing artefacts, or off-vocabulary for an art gallery. Keep the spirit of the corpus.

Templates (top by frequency):
${opts.topTemplates.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Raw fillers per slot:
- noun: ${opts.fillersBySlot.noun.join(', ')}
- verb: ${opts.fillersBySlot.verb.join(', ')}
- adjective: ${opts.fillersBySlot.adjective.join(', ')}

Return ONLY JSON in this exact shape, no prose:
{
  "slot_names": { "noun": "<name>", "verb": "<name>", "adjective": "<name>" },
  "fillers": {
    "<noun name>": ["filler", "filler", ...],
    "<verb name>": ["filler", ...],
    "<adjective name>": ["filler", ...]
  }
}

Do not use em dashes. Keep filler lists under 40 items each.`;

  let raw: string;
  try {
    raw = await provider.text(prompt);
  } catch (err) {
    console.error('  LLM cleanup failed:', err);
    return null;
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fenced ? fenced[1]! : raw;
  try {
    const parsed = JSON.parse(body);
    if (!parsed?.slot_names || !parsed?.fillers) return null;
    return parsed as LLMCleanup;
  } catch (err) {
    console.error('  LLM cleanup JSON parse failed:', err);
    return null;
  }
}

async function main() {
  const ownerId = process.env.OWNER_GITHUB_ID;
  if (!ownerId) {
    console.error('OWNER_GITHUB_ID not set -- need the site admin user id to scope the corpus.');
    process.exit(1);
  }
  const useLLM = process.argv.includes('--llm');

  const corpus = await loadCorpus(ownerId);
  if (corpus.length === 0) {
    console.error('no captions or descriptions found for owner', ownerId);
    process.exit(1);
  }
  console.log(`scanning ${corpus.length} caption/description rows...`);

  const templateCounts: Counts = new Map();
  const fillerCounts: Record<SlotType, Counts> = {
    noun: new Map(),
    verb: new Map(),
    adjective: new Map()
  };

  for (const text of corpus) {
    const { template, fillers } = extractFromText(text);
    if (!template.includes('[')) continue;
    templateCounts.set(template, (templateCounts.get(template) ?? 0) + 1);
    for (const f of fillers) {
      const m = fillerCounts[f.slot];
      m.set(f.text, (m.get(f.text) ?? 0) + 1);
    }
  }

  console.log(`  ${templateCounts.size} distinct templates, ${SLOT_TYPES.map(
    (s) => `${fillerCounts[s].size} ${s} fillers`
  ).join(', ')}`);

  // Optional LLM cleanup.
  let slotRename: Record<SlotType, string> = { noun: 'noun', verb: 'verb', adjective: 'adjective' };
  let fillersFinal: Record<string, { filler: string; weight: number }[]> = {};
  if (useLLM) {
    const topTemplates = topByCount(templateCounts, 20).map((t) => t.key);
    const fillersBySlot: Record<SlotType, string[]> = {
      noun: topByCount(fillerCounts.noun, 40).map((f) => f.key),
      verb: topByCount(fillerCounts.verb, 40).map((f) => f.key),
      adjective: topByCount(fillerCounts.adjective, 40).map((f) => f.key)
    };
    const cleanup = await llmCleanup({ ownerId, topTemplates, fillersBySlot });
    if (cleanup) {
      slotRename = cleanup.slot_names;
      for (const slot of SLOT_TYPES) {
        const newName = slotRename[slot];
        const curated = cleanup.fillers[newName] ?? [];
        fillersFinal[newName] = curated.map((f) => ({ filler: f, weight: 1 }));
      }
    }
  }

  // If no LLM pass or it failed, use raw POS fillers with frequency-as-weight.
  if (Object.keys(fillersFinal).length === 0) {
    for (const slot of SLOT_TYPES) {
      const entries = [...fillerCounts[slot].entries()].map(([filler, n]) => ({
        filler,
        weight: n
      }));
      fillersFinal[slotRename[slot]] = entries;
    }
  }

  // Apply slot rename to the templates before persisting. We rewrite [noun]
  // -> [<new name>] so the artifact reads with the chosen vocabulary.
  function rewriteTemplate(t: string): string {
    let out = t;
    for (const slot of SLOT_TYPES) {
      const newName = slotRename[slot];
      if (newName === slot) continue;
      out = out.replaceAll(`[${slot}]`, `[${newName}]`);
    }
    return out;
  }

  console.log('writing grammar to DB...');
  await clearGrammar(ownerId);

  const slotRows: { template: string; frequency: number }[] = [];
  for (const [template, freq] of templateCounts) {
    if (freq < MIN_TEMPLATE_FREQ) continue;
    slotRows.push({ template: rewriteTemplate(template), frequency: freq });
  }
  // De-dupe templates that collapse to the same string after rewrite (e.g.
  // two POS-only templates that map to the same renamed-slot template),
  // summing their frequencies.
  const dedupedSlots = new Map<string, number>();
  for (const r of slotRows) {
    dedupedSlots.set(r.template, (dedupedSlots.get(r.template) ?? 0) + r.frequency);
  }
  const slotInserts = [...dedupedSlots.entries()].map(([template, frequency]) => ({
    template,
    frequency
  }));
  await bulkInsertSlots(ownerId, slotInserts);

  const fillerInserts: { slotName: string; filler: string; weight: number }[] = [];
  // Dedupe (slotName, filler) too -- the LLM cleanup may emit duplicates.
  const seen = new Set<string>();
  for (const [slotName, entries] of Object.entries(fillersFinal)) {
    for (const { filler, weight } of entries) {
      if (!filler) continue;
      const key = `${slotName} ${filler}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fillerInserts.push({ slotName, filler, weight });
    }
  }
  await bulkInsertFillers(ownerId, fillerInserts);

  console.log(`done: ${slotInserts.length} templates, ${fillerInserts.length} fillers.`);
  console.log(`slot names: ${JSON.stringify(slotRename)}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
