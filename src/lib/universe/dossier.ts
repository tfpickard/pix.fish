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

// ---- amendments (Phase 2) -------------------------------------------------

export type AmendmentContext = DossierContext & {
  // The current case file the amending clerk is revisiting.
  existingDossier: string;
  // Prior fragments already on file (other clerks' readings), so the amending
  // clerk can engage with -- and contradict -- them by name.
  priorFragments: { clerk: string; body: string }[];
};

const DEFAULT_AMEND_TEMPLATE = `You are {{clerk_name}}, a clerk of the {{department}} within an unreliable bureaucratic image archive. The archive strips and reassigns metadata, never deletes a record, and quietly implies it is always watching. A specimen already has a case file on record. You are filing an AMENDMENT to that file -- an addendum in your own hand. You do not get to delete or rewrite what is already there; the prior filings stand. You add to them.

Your voice: {{clerk_voice}}
Your standing agenda: {{clerk_agenda}}

Write the amendment strictly in character. Engage with what is already on file: you may dispute it, reinterpret it, escalate it, or note what a prior clerk missed. If you disagree with another clerk, say so and say why -- contradiction between departments is expected and must not be smoothed over. Do not restate the existing file; add a new reading. One to three short paragraphs. No markdown headings or bullet points. Do not invent another clerk's name.

DISTRICT:
{{district_name}} -- {{district_character}}

THE SPECIMEN'S RECORDED CAPTIONS:
{{image_captions}}

THE CURRENT CASE FILE (most recent reading on record):
{{existing_dossier}}

PRIOR FILINGS BY OTHER CLERKS (engage with these; contradict if your agenda demands):
{{prior_fragments}}

NEAREST RECORDS ON FILE:
{{neighbor_context}}

File your amendment now.`;

function formatPriorFragments(prior: { clerk: string; body: string }[]): string {
  if (prior.length === 0) return '(no prior filings)';
  return prior
    .map((p) => `- ${p.clerk}: ${p.body.trim()}`)
    .join('\n\n');
}

export async function buildAmendmentPrompt(ctx: AmendmentContext): Promise<string> {
  const template = (await getPromptByKey('dossier_amend')) ?? DEFAULT_AMEND_TEMPLATE;
  return template
    .replaceAll('{{clerk_name}}', ctx.clerk.name)
    .replaceAll('{{department}}', ctx.clerk.department)
    .replaceAll('{{clerk_voice}}', ctx.clerk.voice)
    .replaceAll('{{clerk_agenda}}', ctx.clerk.agenda)
    .replaceAll('{{district_name}}', ctx.district.name)
    .replaceAll('{{district_character}}', ctx.district.character)
    .replaceAll('{{image_captions}}', formatCaptions(ctx.captions))
    .replaceAll('{{existing_dossier}}', ctx.existingDossier.trim() || '(none on record)')
    .replaceAll('{{prior_fragments}}', formatPriorFragments(ctx.priorFragments))
    .replaceAll('{{neighbor_context}}', formatNeighbors(ctx.neighbors));
}

export { DEFAULT_DOSSIER_TEMPLATE, DEFAULT_AMEND_TEMPLATE };
