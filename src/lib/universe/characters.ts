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

// Build a cosine kNN graph over crop description-embeddings: each crop gets
// edges to its `k` nearest other crops. The result feeds detectCommunities()
// (each community = one recurring character). O(n^2) over a few hundred crops
// is fine. Deterministic: ties broken by crop id.
export function buildCropEdges(
  crops: { cropId: number; vec: number[] }[],
  k = 5
): ClusterEdge[] {
  const edges: ClusterEdge[] = [];
  for (let i = 0; i < crops.length; i++) {
    const src = crops[i]!;
    const dists: { dst: number; dist: number }[] = [];
    for (let j = 0; j < crops.length; j++) {
      if (j === i) continue;
      dists.push({ dst: crops[j]!.cropId, dist: cosineDist(src.vec, crops[j]!.vec) });
    }
    dists.sort((a, b) => a.dist - b.dist || a.dst - b.dst);
    for (const nb of dists.slice(0, k)) {
      edges.push({ src: src.cropId, dst: nb.dst, dist: nb.dist });
    }
  }
  return edges;
}

export { DEFAULT_CHARACTER_DETECT_TEMPLATE, DEFAULT_CHARACTER_DOSSIER_TEMPLATE };
