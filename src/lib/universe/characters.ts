import { getPromptByKey } from '@/lib/db/queries/prompts';
import type { ClusterEdge } from './cluster';

// Phase 3 character helpers: prompt construction (detection + dossier synthesis)
// and the cosine kNN edge builder that feeds detectCommunities(). The LLM/embed
// calls themselves are orchestrated by the jobs; this module is prompt text +
// pure math, so it stays testable and provider-agnostic.

// ---- detection prompt -----------------------------------------------------

const DEFAULT_CHARACTER_DETECT_TEMPLATE = `You are an intake examiner for an unreliable bureaucratic image archive. Identify the distinct FIGURES in this specimen -- persons, creatures, and other recurring character-like beings. Ignore inanimate objects, scenery, and background props; only catalogue figures that could recur as a character across the archive.

For each figure return:
- "label": a 1 to 4 word identifier (e.g. "the analyst", "horned patient")
- "description": 1 to 2 sentences describing the figure's appearance in concrete, distinguishing visual terms (build, attire, features, posture) -- enough that the same figure could be recognized in another image. Do NOT describe the setting.
- "box": its bounding box as {"left","top","width","height"}, each a fraction from 0 to 1 of the image dimensions, tight around the figure (head-and-shoulders is fine for a headshot).

Return ONLY JSON: {"figures": [{"label": "...", "description": "...", "box": {"left": 0.0, "top": 0.0, "width": 0.0, "height": 0.0}}]}. If there are no clear figures, return {"figures": []}. List at most 6 figures, most prominent first.`;

export async function buildDetectPrompt(): Promise<string> {
  return (await getPromptByKey('character_detect')) ?? DEFAULT_CHARACTER_DETECT_TEMPLATE;
}

// ---- dossier synthesis prompt ---------------------------------------------

const DEFAULT_CHARACTER_DOSSIER_TEMPLATE = `You are {{clerk_name}}, a clerk of the {{department}} within an unreliable bureaucratic image archive. The archive has determined that a single recurring figure -- a "person of interest" -- appears across multiple specimens. Below are the per-image descriptions filed for that figure.

Your voice: {{clerk_voice}}
Your standing agenda: {{clerk_agenda}}

Give this recurring subject a name and file a dossier on them, strictly in character. The name should be evocative and faintly bureaucratic (a designation, not a real-world name). The dossier is 1 to 3 short paragraphs treating the figure as a recurring subject the institution is tracking across its files -- note what persists about them, what the recurrences imply, and read into it per your agenda. Do not describe individual images; characterize the recurring subject.

Return ONLY JSON: {"name": "...", "dossier": "..."}.

DESCRIPTIONS ON FILE (one per appearance):
{{descriptions}}

APPEARS IN {{count}} SPECIMENS.`;

export type CharacterDossierContext = {
  clerk: { name: string; department: string; voice: string; agenda: string };
  descriptions: string[];
  count: number;
};

export async function buildCharacterDossierPrompt(ctx: CharacterDossierContext): Promise<string> {
  const template = (await getPromptByKey('character_dossier')) ?? DEFAULT_CHARACTER_DOSSIER_TEMPLATE;
  const descriptions = ctx.descriptions
    .map((d) => d.trim())
    .filter(Boolean)
    .slice(0, 24)
    .map((d) => `- ${d}`)
    .join('\n');
  return template
    .replaceAll('{{clerk_name}}', ctx.clerk.name)
    .replaceAll('{{department}}', ctx.clerk.department)
    .replaceAll('{{clerk_voice}}', ctx.clerk.voice)
    .replaceAll('{{clerk_agenda}}', ctx.clerk.agenda)
    .replaceAll('{{descriptions}}', descriptions || '(none on file)')
    .replaceAll('{{count}}', String(ctx.count));
}

export type CharacterIdentity = { name: string; dossier: string };

export function parseCharacterIdentity(raw: string, fallbackKey: string): CharacterIdentity {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const obj = JSON.parse(stripped) as Partial<CharacterIdentity>;
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : null;
    const dossier = typeof obj.dossier === 'string' && obj.dossier.trim() ? obj.dossier.trim() : null;
    if (name && dossier) return { name, dossier };
  } catch {
    // fall through
  }
  return {
    name: `Subject ${fallbackKey.replace('character-', '')}`,
    dossier: 'A recurring figure the archive has flagged but not yet characterized.'
  };
}

// ---- clustering input -----------------------------------------------------

function cosineDist(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}

// Above this cosine distance two crop descriptions are treated as unrelated and
// never linked, no matter how few crops there are. Without a cutoff, a corpus
// with fewer than k+1 crops links every crop to every other (kNN degenerates to
// "all of them"), and community detection then fuses two unrelated figures into
// one false "recurring" character. Tunable; conservative by default so sparse
// corpora under-cluster (miss a character) rather than invent one.
export const DEFAULT_CROP_EDGE_MAX_DIST = 0.45;

// ---- cluster vector selection (text / visual / blend) ---------------------

function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return n === 0 ? v : v.map((x) => x / n);
}

// Pick the vector clustering should run on for one crop, per the chosen space.
// 'text' = description embedding; 'visual' = pixel embedding; 'blend' = both,
// concatenated after L2-normalizing and scaling by sqrt of their weight, so the
// cosine distance of two blended vectors equals (1-w)*textDist + w*visualDist
// (w = blendWeight, the visual share). Returns null when a needed vector is
// missing (e.g. visual/blend before backfill) so the caller can skip that crop.
export function cropClusterVector(
  crop: { vec: number[]; vecImage: number[] | null },
  space: 'text' | 'visual' | 'blend',
  blendWeight: number
): number[] | null {
  const hasText = crop.vec.length > 0;
  const hasVisual = !!crop.vecImage && crop.vecImage.length > 0;
  if (space === 'text') return hasText ? crop.vec : null;
  if (space === 'visual') return hasVisual ? crop.vecImage : null;
  // blend. Degenerate weights collapse to a single space so they don't demand a
  // vector that contributes zero: w=0 is all-text (no visual needed), w=1 is
  // all-visual. Only a genuine mix (0<w<1) needs both.
  const w = Math.min(1, Math.max(0, blendWeight));
  if (w === 0) return hasText ? crop.vec : null;
  if (w === 1) return hasVisual ? crop.vecImage! : null;
  if (!hasText || !hasVisual) return null;
  const t = l2normalize(crop.vec).map((x) => x * Math.sqrt(1 - w));
  const i = l2normalize(crop.vecImage!).map((x) => x * Math.sqrt(w));
  return [...t, ...i];
}

// Build a cosine kNN graph over crop description-embeddings: each crop gets
// edges to its `k` nearest other crops, dropping any neighbour farther than
// maxDist. The result feeds detectCommunities() (each community = one recurring
// character). O(n^2) over a few hundred crops is fine. Deterministic: ties
// broken by crop id.
export function buildCropEdges(
  crops: { cropId: number; vec: number[] }[],
  k = 5,
  maxDist = DEFAULT_CROP_EDGE_MAX_DIST
): ClusterEdge[] {
  const edges: ClusterEdge[] = [];
  for (let i = 0; i < crops.length; i++) {
    const src = crops[i]!;
    const dists: { dst: number; dist: number }[] = [];
    for (let j = 0; j < crops.length; j++) {
      if (j === i) continue;
      const dist = cosineDist(src.vec, crops[j]!.vec);
      if (dist > maxDist) continue; // unrelated; never an edge
      dists.push({ dst: crops[j]!.cropId, dist });
    }
    dists.sort((a, b) => a.dist - b.dist || a.dst - b.dst);
    for (const nb of dists.slice(0, k)) {
      edges.push({ src: src.cropId, dst: nb.dst, dist: nb.dist });
    }
  }
  return edges;
}

// ---- mosaic verification (precision pass) ---------------------------------

// Prompt for the mosaic "captcha": the model sees a numbered grid of candidate
// crops and partitions the cells into same-INDIVIDUAL groups. This is where the
// weak text-embedding clustering gets corrected by real visual discrimination
// (two different frogs, or two different anthropomorphic fish, split apart).
const DEFAULT_CHARACTER_VERIFY_TEMPLATE = `You are an identity examiner for an image archive. The grid below contains {{n}} cropped figures, each labelled with a number ({{range}}). An automatic pass grouped them as POSSIBLY the same recurring character, but the grouping is noisy and mixes different individuals.

Partition the numbered cells into groups so that every cell in a group is the SAME SPECIFIC INDIVIDUAL -- not merely the same species, type, or art style. Two figures that are clearly different individuals (even if both are frogs, or both are anthropomorphic fish) must go in DIFFERENT groups. A cell that matches no other belongs in its own singleton group.

Rules:
- Judge by distinguishing visual identity (features, markings, build, palette), not by category alone.
- Every cell number from {{range}} must appear EXACTLY ONCE across all groups.
- Prefer splitting when unsure: it is better to separate two lookalikes than to merge two different individuals.

Return ONLY JSON: {"groups": [[1,3,5],[2,4],[6]]}.`;

export async function buildVerifyPrompt(cellCount: number): Promise<string> {
  const template = (await getPromptByKey('character_verify')) ?? DEFAULT_CHARACTER_VERIFY_TEMPLATE;
  return template
    .replaceAll('{{n}}', String(cellCount))
    .replaceAll('{{range}}', cellCount > 0 ? `1..${cellCount}` : '1');
}

// Parse the verifier's {"groups": [[1,3],[2]]} into 0-based index groups,
// clamped to 0..cellCount-1. Deduplicates within/across groups (each cell lands
// in the first group that claims it) and appends any cell the model omitted as
// its own singleton, so the partition is always total and disjoint.
export function parseVerifyGroups(raw: string, cellCount: number): number[][] {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const seen = new Set<number>();
  const groups: number[][] = [];
  try {
    const obj = JSON.parse(stripped) as { groups?: unknown };
    if (Array.isArray(obj.groups)) {
      for (const g of obj.groups) {
        if (!Array.isArray(g)) continue;
        const group: number[] = [];
        for (const cell of g) {
          const idx = Math.trunc(Number(cell)) - 1; // 1-based -> 0-based
          if (Number.isInteger(idx) && idx >= 0 && idx < cellCount && !seen.has(idx)) {
            seen.add(idx);
            group.push(idx);
          }
        }
        if (group.length > 0) groups.push(group);
      }
    }
  } catch {
    // fall through -- unparseable means "no confident grouping"
  }
  // Any cell the model dropped becomes its own singleton (never silently lost).
  for (let i = 0; i < cellCount; i++) {
    if (!seen.has(i)) groups.push([i]);
  }
  return groups;
}

export {
  DEFAULT_CHARACTER_DETECT_TEMPLATE,
  DEFAULT_CHARACTER_DOSSIER_TEMPLATE,
  DEFAULT_CHARACTER_VERIFY_TEMPLATE
};
