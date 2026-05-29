// Pluggable text-to-image generation, for feat/alive (synthetic children).
//
// The project ships no image-generation provider yet (ground rule 7). This
// file is the Gate-0 contract: a stable interface plus a stub so feat/alive
// can build and dry-run the reproduction pipeline end to end. The OWNER must
// wire a real adapter (and its API key) before live births produce real
// imagery -- see getImageGenerator() and CONTRACTS.md.
//
// Like the AIProvider abstraction, all SDK calls for a real adapter MUST live
// in src/lib/ai/; callers go through getImageGenerator().

export type ImageGenRequest = {
  // Text-to-image prompt. feat/alive builds this from the child's blended
  // caption; it must already obey the no-em-dash rule.
  prompt: string;
  width?: number;
  height?: number;
  // Optional determinism hint for adapters that support it.
  seed?: number;
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

// Factory. Returns the configured generator, or the stub when none is wired.
// Never returns null: feat/alive always has something to call, and dry-run
// never calls generate() at all. When the owner adds a real provider, branch
// on an env var here (e.g. IMAGEGEN_PROVIDER) and construct it -- keeping the
// SDK call inside src/lib/ai/.
export function getImageGenerator(): ImageGenerator {
  return new StubImageGenerator();
}
