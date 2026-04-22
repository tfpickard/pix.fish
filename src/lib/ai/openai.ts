import OpenAI from 'openai';
import type { AIProvider, AITag } from './types';
import { parseTagsJson, parseVariantsJson } from './types';

const MODEL = 'gpt-4o';
const EMBED_MODEL = 'text-embedding-3-small';
// text-embedding-3-small is a fixed 1536-dim model. If we ever route to
// another model this number has to change in lockstep with the embeddings.vec
// column dimensions in schema.ts.
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

async function callVision(image: Buffer, mime: string, prompt: string): Promise<string> {
  const dataUrl = `data:${mime};base64,${image.toString('base64')}`;
  const res = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]
  });
  const text = res.choices[0]?.message?.content ?? '';
  if (!text) throw new Error('OpenAI response had no content.');
  return text;
}

export const OpenAIProvider: AIProvider = {
  name: 'openai',
  model: MODEL,
  embedModel: EMBED_MODEL,

  async captions(image, mime, prompt) {
    const text = await callVision(image, mime, prompt);
    return parseVariantsJson(text);
  },

  async descriptions(image, mime, prompt) {
    const text = await callVision(image, mime, prompt);
    return parseVariantsJson(text);
  },

  async tags(image, mime, prompt): Promise<AITag[]> {
    const text = await callVision(image, mime, prompt);
    return parseTagsJson(text);
  },

  async embed(input: string): Promise<number[]> {
    const res = await getClient().embeddings.create({
      model: EMBED_MODEL,
      input
    });
    const vec = res.data[0]?.embedding;
    if (!vec) throw new Error('OpenAI embeddings response had no vector.');
    if (vec.length !== EMBED_DIMENSIONS) {
      throw new Error(
        `OpenAI embeddings returned ${vec.length} dims; expected ${EMBED_DIMENSIONS} for ${EMBED_MODEL}.`
      );
    }
    if (!vec.every((n) => Number.isFinite(n))) {
      throw new Error('OpenAI embeddings response contained non-finite numbers.');
    }
    return vec;
  }
};
