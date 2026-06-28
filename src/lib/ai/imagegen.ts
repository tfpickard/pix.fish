// Pluggable text-to-image generation, for feat/alive (synthetic children).
//
// Like the AIProvider abstraction, all SDK calls for a real adapter MUST live
// in src/lib/ai/; callers go through getImageGenerator().
//
// Provider and model are configured via /admin/ai (stored in ai_config table,
// field='imagegen'). The API key still comes from the env var OPENROUTER_API_KEY
// because keys are site-level credentials, not per-user BYO rows.
// Callers load config via loadImageGenConfig() from src/lib/ai/loadConfig.ts
// and pass it to getImageGenerator(cfg).

export type ImageGenRequest = {
  // Text-to-image prompt. feat/alive builds this from the child's blended
  // caption; it must already obey the no-em-dash rule.
  prompt: string;
  width?: number;
  height?: number;
  // Optional determinism hint for adapters that support it.
  seed?: number;
  // Optional cancellation. Long, paid renders (fuse.render) abort the in-flight
  // fetch on a time budget rather than leaving it dangling when the function is
  // killed at the wall.
  signal?: AbortSignal;
};

export type ImageGenResult = {
  // Raw bytes, ready to hand to Vercel Blob `put()` (the same path uploads use).
  bytes: Buffer;
  mime: string; // e.g. 'image/png'
  // Stamped onto the image row for provenance, mirroring caption/embedding rows.
  provider: string;
  model: string;
};

export interface ImageGenerator {
  readonly name: string;
  readonly model: string;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

// 1x1 transparent PNG. The stub returns this so the reproduction pipeline
// (insert row -> blob upload -> caption -> lineage) is fully exercisable
// without a real provider. It is deliberately not a "plausible" image: a real
// adapter is required for that, and the stub logs a warning so it cannot be
// mistaken for one in production.
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

export class StubImageGenerator implements ImageGenerator {
  readonly name = 'stub';
  readonly model = 'placeholder-1x1';
  async generate(_req: ImageGenRequest): Promise<ImageGenResult> {
    console.warn(
      '[imagegen] StubImageGenerator: returning a 1x1 placeholder. Wire a real ImageGenerator before enabling live births.'
    );
    return { bytes: PLACEHOLDER_PNG, mime: 'image/png', provider: 'stub', model: this.model };
  }
}

// OpenRouter adapter -- routes to FLUX.1-schnell-Free (or IMAGEGEN_MODEL override)
// via the OpenAI-compatible images/generations endpoint. OpenRouter returns
// base64 image data; we decode it into a Buffer ready for Vercel Blob.
export class OpenRouterImageGenerator implements ImageGenerator {
  readonly name = 'openrouter';
  readonly model: string;
  private apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? 'black-forest-labs/FLUX.1-schnell-Free';
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      prompt: req.prompt,
      n: 1,
      response_format: 'b64_json'
    };
    if (req.width) body.width = req.width;
    if (req.height) body.height = req.height;

    const res = await fetch('https://openrouter.ai/api/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL ?? 'https://pix.fish',
        'X-Title': 'pix.fish'
      },
      body: JSON.stringify(body),
      signal: req.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`OpenRouter image gen failed (${res.status}): ${text}`);
    }

    type OpenRouterResponse = { data: { b64_json: string }[] };
    const json = await res.json() as OpenRouterResponse;
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenRouter returned no image data');

    return {
      bytes: Buffer.from(b64, 'base64'),
      mime: 'image/png',
      provider: 'openrouter',
      model: this.model
    };
  }
}

// OpenAI adapter -- text-to-image via the Images API with the gpt-image-2 model
// (POST https://api.openai.com/v1/images/generations). This is the target the
// /fuse composite prompt (src/lib/fuse/composite-prompt.ts) is written for. The
// gpt-image family always returns base64 image data (no url option), which we
// decode into a Buffer ready for Vercel Blob. Site-level key from
// OPENAI_API_KEY, the same env var the caption/embedding providers fall back to.
export class OpenAIImageGenerator implements ImageGenerator {
  readonly name = 'openai';
  readonly model: string;
  private apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? 'gpt-image-2';
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      prompt: req.prompt,
      n: 1
    };
    // gpt-image takes a `size` string (e.g. "1024x1024"), not width/height. Only
    // send it when both dims are given; otherwise omit it so the model uses its
    // default (safer than guessing a value it might reject). We deliberately do
    // NOT send `response_format`: the gpt-image family rejects that parameter and
    // always returns base64 (`b64_json`), so requesting it would error.
    if (req.width && req.height) {
      body.size = `${Math.round(req.width)}x${Math.round(req.height)}`;
    }

    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body),
      signal: req.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`OpenAI image gen failed (${res.status}): ${text}`);
    }

    // gpt-image returns b64_json; tolerate a `url` too (in case a routed model
    // returns one) by fetching the bytes.
    type OpenAIImageResponse = { data: { b64_json?: string; url?: string }[] };
    const json = (await res.json()) as OpenAIImageResponse;
    const item = json.data?.[0];
    if (item?.b64_json) {
      return {
        bytes: Buffer.from(item.b64_json, 'base64'),
        mime: 'image/png',
        provider: 'openai',
        model: this.model
      };
    }
    if (item?.url) {
      const imgRes = await fetch(item.url, { signal: req.signal });
      if (!imgRes.ok) throw new Error(`OpenAI image url fetch failed (${imgRes.status})`);
      return {
        bytes: Buffer.from(await imgRes.arrayBuffer()),
        mime: imgRes.headers.get('content-type') ?? 'image/png',
        provider: 'openai',
        model: this.model
      };
    }
    throw new Error('OpenAI returned no image data');
  }
}

// Factory. Accepts the resolved config from loadImageGenConfig() so the
// provider/model come from the DB (editable at /admin/ai), with the API key
// pulled from the env. Never returns null: the alive pipeline always has
// something to call; dry-run never calls generate() at all.
export function getImageGenerator(cfg?: { provider: string; model: string }): ImageGenerator {
  const provider = cfg?.provider ?? 'stub';
  const model = cfg?.model;
  if (provider === 'openrouter') {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      console.warn('[imagegen] provider=openrouter but OPENROUTER_API_KEY is not set -- falling back to stub');
      return new StubImageGenerator();
    }
    return new OpenRouterImageGenerator(key, model);
  }
  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      console.warn('[imagegen] provider=openai but OPENAI_API_KEY is not set -- falling back to stub');
      return new StubImageGenerator();
    }
    return new OpenAIImageGenerator(key, model);
  }
  return new StubImageGenerator();
}
