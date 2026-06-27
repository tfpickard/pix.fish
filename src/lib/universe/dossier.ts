import { getPromptByKey } from '@/lib/db/queries/prompts';

// Builds the generation prompt for a clerk's intake dossier. The base template
// lives in the prompts table (key 'dossier') so the institution's house style
// is tunable without a redeploy; the clerk's voice/agenda and the RAG context
// are substituted in here at write time. Providers never see a hardcoded
// prompt -- they receive the resolved string.

export type DossierNeighbor = {
  slug: string;
  caption: string;
  dossier?: string | null;
};

export type DossierContext = {
  clerk: { name: string; department: string; voice: string; agenda: string };
  captions: string[];
  neighbors: DossierNeighbor[];
  district: { name: string; character: string };
  crossReferences: { slug: string; dist: number }[];
};

// Fallback used only if the 'dossier' prompt row is missing (e.g. the universe
// seed has not run). Keeping a default here means the bootstrap still produces
// output; the DB row, when present, always wins.
const DEFAULT_DOSSIER_TEMPLATE = `You are {{clerk_name}}, a clerk of the {{department}} within an unreliable bureaucratic image archive. The archive strips and reassigns metadata, never deletes a record, and quietly implies it is always watching. You are filing an intake dossier for a single specimen (an image catalogued by the institution).

Your voice: {{clerk_voice}}
Your standing agenda: {{clerk_agenda}}

Write the dossier strictly in character and in your own voice. Do not describe the image neutrally; file it the way your department and agenda demand. You may contradict how another clerk would read the same specimen -- that is expected and must not be softened. Refer to the specimen as a record under your care. Two to four short paragraphs. Do not use markdown headings or bullet points. Do not invent a different clerk's name.

DISTRICT (the region of the archive this specimen was filed under):
{{district_name}} -- {{district_character}}

THE SPECIMEN'S RECORDED CAPTIONS:
{{image_captions}}

NEAREST RECORDS ON FILE (cross-referenced neighbours; cite them if relevant):
{{neighbor_context}}

DIRECTED CROSS-REFERENCES ALREADY ESTABLISHED:
{{cross_references}}

File the dossier now.`;

function formatCaptions(captions: string[]): string {
  const clean = captions.map((c) => c.trim()).filter(Boolean);
  if (clean.length === 0) return '(no caption on record)';
  return clean.map((c) => `- ${c}`).join('\n');
}

function formatNeighbors(neighbors: DossierNeighbor[]): string {
  if (neighbors.length === 0) return '(no neighbouring records)';
  return neighbors
    .map((n) => {
      const lead = `- ${n.slug}: ${n.caption.trim() || '(uncaptioned)'}`;
      const filed = n.dossier?.trim() ? `\n    prior filing: ${n.dossier.trim()}` : '';
      return lead + filed;
    })
    .join('\n');
}

function formatCrossReferences(refs: { slug: string; dist: number }[]): string {
  if (refs.length === 0) return '(none established)';
  return refs.map((r) => `- ${r.slug} (distance ${r.dist.toFixed(3)})`).join('\n');
}

export async function buildDossierPrompt(ctx: DossierContext): Promise<string> {
  const template = (await getPromptByKey('dossier')) ?? DEFAULT_DOSSIER_TEMPLATE;
  return template
    .replaceAll('{{clerk_name}}', ctx.clerk.name)
    .replaceAll('{{department}}', ctx.clerk.department)
    .replaceAll('{{clerk_voice}}', ctx.clerk.voice)
    .replaceAll('{{clerk_agenda}}', ctx.clerk.agenda)
    .replaceAll('{{district_name}}', ctx.district.name)
    .replaceAll('{{district_character}}', ctx.district.character)
    .replaceAll('{{image_captions}}', formatCaptions(ctx.captions))
    .replaceAll('{{neighbor_context}}', formatNeighbors(ctx.neighbors))
    .replaceAll('{{cross_references}}', formatCrossReferences(ctx.crossReferences));
}

export { DEFAULT_DOSSIER_TEMPLATE };
