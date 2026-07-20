// Prompt builder for naming a desire path. Pure (no AI import) so it stays
// testable; the desire.promote job resolves the provider and calls provider.text
// with this string. The institution names a route the way it names everything:
// as a formality imposed after the fact on something visitors did on their own.

export type RouteStop = { slug: string; caption: string };

const MAX_STOPS_IN_PROMPT = 12;
const MAX_CAPTION_CHARS = 160;

function formatStops(stops: RouteStop[]): string {
  const shown = stops.slice(0, MAX_STOPS_IN_PROMPT);
  const omitted = stops.length - shown.length;
  const lines = shown.map((s, i) => {
    const cap = s.caption.trim().slice(0, MAX_CAPTION_CHARS) || '(uncaptioned)';
    return `${i + 1}. ${s.slug}: ${cap}`;
  });
  if (omitted > 0) lines.push(`(+${omitted} further stop(s))`);
  return lines.join('\n');
}

// One deadpan naming. Kept inline rather than in the prompts table so the job
// works without a seed; a future pass can promote this to a `desire_path` prompt
// key the way dossier.ts falls back to a default template.
export function buildRouteNamePrompt(stops: RouteStop[]): string {
  return `You are a clerk of an unreliable bureaucratic image archive. Visitors, unprompted, have walked repeatedly between the following specimens, wearing a route into the collection. The archive did not plan this route; it is now obliged to designate it -- a right of way established by use.

Give the route a short name and one sentence of description, in the archive's voice: deadpan, administrative, never winking. Treat the route as a corridor or passage through the holdings. Do not endorse it; merely record that it exists and note where it runs. Two sentences at most. No markdown, no quotation marks, no preamble -- return only the designation itself.

The stops, in the order walked:
${formatStops(stops)}

File the designation now.`;
}
