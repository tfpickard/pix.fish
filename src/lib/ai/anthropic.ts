import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, AITag } from './types';
import { parseTagsJson, parseVariantsJson } from './types';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-6';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set; cannot call Anthropic provider.');
  }
  client = new Anthropic({ apiKey });
  return client;
}

async function callVision(
  model: string,
  image: Buffer,
  mime: string,
  prompt: string,
  imageUrl?: string
): Promise<string> {
  // Prefer URL source when available -- sidesteps the 5 MB base64 cap and
  // skips re-encoding the buffer we already uploaded to Blob. The SDK at
  // 0.35 lacks typings for { type: 'url' } source; the server accepts it
  // (added server-side in Aug 2024), so we cast through unknown.
  const source = (imageUrl
    ? { type: 'url', url: imageUrl }
    : {
        type: 'base64',
        media_type: normalizeMime(mime) as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
        data: image.toString('base64')
      }) as unknown as {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
    data: string;
  };
  const res = await getClient().messages.create({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source },
          { type: 'text', text: prompt }
        ]
      }
    ]
  });
  const block = res.content.find((c) => c.type === 'text');
  if (!block || block.type !== 'text') {
    throw new Error('Anthropic response had no text block.');
  }
  return block.text;
}

function normalizeMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower === 'image/jpg') return 'image/jpeg';
  return lower;
}

export function createAnthropicProvider(model: string = ANTHROPIC_DEFAULT_MODEL): AIProvider {
  return {
    name: 'anthropic',
    model,

    async captions(image, mime, prompt, imageUrl) {
      const text = await callVision(model, image, mime, prompt, imageUrl);
      return parseVariantsJson(text);
    },

    async descriptions(image, mime, prompt, imageUrl) {
      const text = await callVision(model, image, mime, prompt, imageUrl);
      return parseVariantsJson(text);
    },

    async tags(image, mime, prompt, imageUrl): Promise<AITag[]> {
      const text = await callVision(model, image, mime, prompt, imageUrl);
      return parseTagsJson(text);
    },

    async text(prompt: string): Promise<string> {
      const res = await getClient().messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
      });
      const block = res.content.find((c) => c.type === 'text');
      if (!block || block.type !== 'text') throw new Error('Anthropic response had no text block.');
      return block.text;
    }
  };
}
