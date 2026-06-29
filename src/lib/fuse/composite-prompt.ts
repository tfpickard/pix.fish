// Composite image-generation prompt for a /fuse pairing. /fuse surfaces the
// nearest EXISTING specimen to two images' embedding centroid; this builds a
// text prompt for the IMAGINED blend that doesn't exist yet -- one cohesive
// image that fuses both subjects into a single impossible whole.
//
// Prompting target: OpenAI's image-2 model (`gpt-image-2`), via the Image API
// (POST https://api.openai.com/v1/images/generations, body { model, prompt,
// size, quality, ... }). The docs recommend descriptive natural language with
// explicit style / lighting / composition direction, which is what this builds.
// See src/lib/ai/imagegen.ts for the wired OpenAIImageGenerator that sends it.
//
// Pure + deterministic (no DB, no Date, no randomness) -- the same pair always
// yields the same prompt, matching the deterministic fusion. Obeys the
// no-em-dash rule (uses --).

// The model id this prompt is written for. Referenced by the UI (to name the
// target) and by /api/fuse/render (which passes it to the image generator), so
// the prompt and the live render stay on the same model id.
export const COMPOSITE_PROMPT_MODEL = 'gpt-image-2';

// Trim a caption to a clean subject clause: drop a trailing period and outer
// whitespace so it reads naturally mid-sentence. Falls back to a neutral phrase
// for an empty/missing caption so the prompt is always well-formed.
function subject(caption: string | undefined): string {
  const s = (caption ?? '').trim().replace(/[.\s]+$/, '');
  return s.length > 0 ? s : 'an unlabeled specimen';
}

// Build the composite prompt from the two parents' captions. Describes a single
// fused subject (not a side-by-side collage), with the style/lighting/negative
// guidance gpt-image-2 responds well to.
export function compositePrompt(captionA: string | undefined, captionB: string | undefined): string {
  const a = subject(captionA);
  const b = subject(captionB);
  return [
    'A single, cohesive image that fuses two subjects into one impossible whole,',
    'not a side-by-side collage.',
    `Subject one: ${a}.`,
    `Subject two: ${b}.`,
    'Merge their forms, textures, palette, and mood into one surreal specimen --',
    'one creature or one scene that could not otherwise exist.',
    'Dreamlike yet hyperreal, painterly volumetric lighting, rich fine detail,',
    'a unified color palette, centered single subject, clean uncluttered background.',
    'No text, no watermark, no caption.'
  ].join(' ');
}
