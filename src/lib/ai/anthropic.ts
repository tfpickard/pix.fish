import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, AITag } from './types';
import { parseTagsJson, parseVariantsJson } from './types';

const MODEL = 'claude-sonnet-4-6';

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

async function callVision(image: Buffer, mime: string, prompt: string): Promise<string> {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: normalizeMime(mime) as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
              data: image.toString('base64')
            }
          },
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

export const AnthropicProvider: AIProvider = {
  name: 'anthropic',
  model: MODEL,

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
  }
};
