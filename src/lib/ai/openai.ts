import OpenAI from 'openai';
import type { AIProvider, AITag } from './types';
import { parseTagsJson, parseVariantsJson } from './types';

export const OPENAI_DEFAULT_VISION_MODEL = 'gpt-4o';
export const OPENAI_DEFAULT_EMBED_MODEL = 'text-embedding-3-small';
// text-embedding-3-small is a fixed 1536-dim model. If we ever route to
// another embedding model this number has to change in lockstep with the
// embeddings.vec column dimensions in schema.ts.
const EMBED_DIMENSIONS = 1536;

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set; cannot call OpenAI provider.');
  }
  client = new OpenAI({ apiKey });
  return client;
}

async function callVision(
  model: string,
  image: Buffer,
  mime: string,
  prompt: string,
  imageUrl?: string
): Promise<string> {
  // Prefer a remote URL so OpenAI fetches the image directly; the data-URL
  // path is the fallback for reprocess jobs that already have a Buffer in
  // hand but no URL (rare; the current reprocess handler passes the URL).
  const url = imageUrl ?? `data:${mime};base64,${image.toString('base64')}`;
  const res = await getClient().chat.completions.create({
    model,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url } }
        ]
      }
    ]
  });
  const text = res.choices[0]?.message?.content ?? '';
  if (!text) throw new Error('OpenAI response had no content.');
  return text;
}

export function createOpenAIProvider(
  opts: { visionModel?: string; embedModel?: string } = {}
): AIProvider {
  const visionModel = opts.visionModel ?? OPENAI_DEFAULT_VISION_MODEL;
  const embedModel = opts.embedModel ?? OPENAI_DEFAULT_EMBED_MODEL;
  return {
    name: 'openai',
    model: visionModel,
    embedModel,

    async captions(image, mime, prompt, imageUrl) {
      const text = await callVision(visionModel, image, mime, prompt, imageUrl);
      return parseVariantsJson(text);
    },

    async descriptions(image, mime, prompt, imageUrl) {
      const text = await callVision(visionModel, image, mime, prompt, imageUrl);
      return parseVariantsJson(text);
    },

    async tags(image, mime, prompt, imageUrl): Promise<AITag[]> {
      const text = await callVision(visionModel, image, mime, prompt, imageUrl);
      return parseTagsJson(text);
    },

    async embed(input: string): Promise<number[]> {
      const res = await getClient().embeddings.create({
        model: embedModel,
        input
      });
      const vec = res.data[0]?.embedding;
      if (!vec) throw new Error('OpenAI embeddings response had no vector.');
      if (vec.length !== EMBED_DIMENSIONS) {
        throw new Error(
          `OpenAI embeddings returned ${vec.length} dims; expected ${EMBED_DIMENSIONS} for ${embedModel}.`
        );
      }
      if (!vec.every((n) => Number.isFinite(n))) {
        throw new Error('OpenAI embeddings response contained non-finite numbers.');
      }
      return vec;
    }
  };
}
