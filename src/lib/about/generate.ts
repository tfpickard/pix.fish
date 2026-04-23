import { getProvider } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';

// Build the bizarre-biography prompt around a field. Kept inline (not in
// the prompts table) because this generator is a one-off owner tool, not a
// pipeline step; the owner iterates by regenerating, not by editing a
// template. The voice hints below are deliberately weird: the output
// should feel like a chapbook bio for someone who took up keelhauling as a
// hobby, not a LinkedIn summary.
function buildPrompt(label: string, existing: string | null): string {
  const seed = existing?.trim()
    ? `Previous text (for thematic continuity, do not quote):\n"""\n${existing.trim()}\n"""\n`
    : '';
  return [
    `You are writing one short section of the "About" page for pix.fish, a personal image gallery with AI enrichment. The site owner is a single anonymous individual; never name them.`,
    `Write the section labeled "${label}" in a bizarre, semi-biographical register: 2 to 4 sentences, first person, anchored to mundane physical detail but with one or two strange turns (imagined jobs, invented regional customs, half-remembered rituals, unlikely hobbies). Avoid cliche, avoid AI-sounding hedges, avoid tech-bro voice.`,
    `Constraints: no em dashes -- use commas, periods, or two hyphens ("--") if needed. No hashtags. No emoji. No meta-commentary about the prompt.`,
    seed,
    `Output only the section's text. No headers, no quotes around it.`
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function generateAboutContent(label: string, existing?: string | null): Promise<string> {
  const cfg = await loadAiConfig();
  // Route through whatever provider is handling captions today (Anthropic
  // by default). The configured model has the right voice for short
  // creative copy.
  const provider = getProvider('captions', cfg);
  if (!provider.text) {
    throw new Error(`provider ${provider.name} does not implement text() for about generation`);
  }
  const out = await provider.text(buildPrompt(label, existing ?? null));
  return out.trim();
}
