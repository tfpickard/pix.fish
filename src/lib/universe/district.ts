// District naming + character synthesis. A district is a community in the kNN
// graph; its identity is synthesized from the captions of its members so the
// name and character emerge from the geometry rather than being assigned by
// hand. The LLM call itself is orchestrated by the bootstrap (which holds the
// provider/keys); this module just builds the prompt and parses the result.

export function buildDistrictPrompt(memberCaptions: string[]): string {
  const sample = memberCaptions
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 24)
    .map((c) => `- ${c}`)
    .join('\n');

  return `You are the cartographer of an unreliable bureaucratic image archive. The records below were clustered together by the institution's machinery because their captions sit near each other in its semantic manifold. They form one district of the archive.

Name this district and describe its character. The name should be 2 to 4 words, evocative and faintly bureaucratic or uncanny, as a wing or sector of a vast archive might be labelled. The character is 1 to 2 sentences describing what the district collects and how it feels, written in the archive's institutional voice.

Return ONLY a JSON object of the form {"name": "...", "character": "..."} with no other text.

RECORDS IN THIS DISTRICT:
${sample || '(no captions on record)'}`;
}

export type DistrictIdentity = { name: string; character: string };

// Parse the model's JSON, tolerating ```json fences. Falls back to a generic
// identity so a single malformed response never aborts the bootstrap.
export function parseDistrictIdentity(raw: string, fallbackKey: string): DistrictIdentity {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const obj = JSON.parse(stripped) as Partial<DistrictIdentity>;
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : null;
    const character =
      typeof obj.character === 'string' && obj.character.trim() ? obj.character.trim() : null;
    if (name && character) return { name, character };
  } catch {
    // fall through to fallback
  }
  return {
    name: `District ${fallbackKey.replace('district-', '')}`,
    character: 'An unlabelled wing of the archive. The institution has not yet settled its character.'
  };
}
