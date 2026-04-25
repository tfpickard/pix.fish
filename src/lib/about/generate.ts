import { getProvider, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { getSiteAdminId } from '@/lib/db/queries/users';

// Build the bizarre-biography prompt around a field. Kept inline (not in
// the prompts table) because this generator is a one-off owner tool, not a
// pipeline step; the owner iterates by regenerating, not by editing a
// template. The voice hints below are deliberately weird: the output
// should feel like a chapbook bio for someone who took up keelhauling as a
// hobby, not a LinkedIn summary.
function buildPrompt(label: string, existing: string | null): string {
  const trimmed = existing?.trim();
  // When the owner has typed a draft in the textarea, treat it as the
  // canonical voice + content seed: the regeneration should *sound
  // like* that draft (sentence rhythm, vocabulary, level of weirdness,
  // first/third-person stance, declarative-vs-questioning tone) and
  // expand on its themes, not replace them with a fresh take. Without
  // this, regenerating a draft you liked produces a stylistic
  // discontinuity each time.
  const seed = trimmed
    ? `Reference draft from the owner -- match its voice, tone, sentence rhythm, and content. Extend or rewrite within that register. Do not quote it verbatim, but stay clearly in its style:\n"""\n${trimmed}\n"""\n`
    : '';
  return [
    `You are writing one short section of the "About" page for pix.fish, a personal image gallery with AI enrichment. The site owner is a single anonymous individual; never name them.`,
    `Write the section labeled "${label}" in a bizarre, semi-biographical register: 2 to 4 sentences, first person, anchored to mundane physical detail but with one or two strange turns (imagined jobs, invented regional customs, half-remembered rituals, unlikely hobbies). Avoid cliche, avoid AI-sounding hedges, avoid tech-bro voice.`,
    `Constraints: no em dashes -- use commas, periods, or two hyphens ("--") if needed. No hashtags. No emoji. No meta-commentary about the prompt.`,
    seed,
    trimmed
      ? `When in doubt between the voice hints above and the reference draft, follow the reference draft.`
      : '',
    `Output only the section's text. No headers, no quotes around it.`
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function generateAboutContent(label: string, existing?: string | null): Promise<string> {
  const cfg = await loadAiConfig();
  // Route through whatever provider is handling captions today (Anthropic
  // by default). The configured model has the right voice for short
  // creative copy. Site-admin's keys: this is admin-only generation today;
  // when per-user about pages land, the caller passes their own user id.
  const adminKeys = await loadUserProviderKeys(getSiteAdminId());
  const provider = getProvider('captions', cfg, adminKeys);
  if (!provider) {
    throw new Error(
      'no anthropic key configured for site admin -- about generation requires a key'
    );
  }
  if (!provider.text) {
    throw new Error(`provider ${provider.name} does not implement text() for about generation`);
  }
  const out = await provider.text(buildPrompt(label, existing ?? null));
  return out.trim();
}
