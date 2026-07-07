// Visual identity embeddings of crop headshots, for character classification.
// A hosted multimodal model (Voyage) embeds the actual pixels into a vector so
// clustering can group by how a figure LOOKS, not how it was described -- the
// text-description embedding can't tell two different frogs (or two different
// anthropomorphic fish) apart. Kept here so the "no SDK calls outside src/lib/ai"
// rule holds; it's a plain fetch, no dependency. Key: VOYAGE_API_KEY (env).

const VOYAGE_URL = 'https://api.voyageai.com/v1/multimodalembeddings';
const VOYAGE_MODEL = 'voyage-multimodal-3.5';
export const IMAGE_EMBED_DIM = 1024; // voyage-multimodal-3.5 default

export type ImageEmbedder = {
  readonly name: string;
  readonly model: string;
  readonly dim: number;
  // Embed an image by its public URL (our crops live on Vercel Blob, so we pass
  // the URL and let Voyage fetch it -- no base64 upload).
  embed(imageUrl: string): Promise<number[]>;
};

// Returns null when no VOYAGE_API_KEY is configured, so callers treat visual
// embedding as best-effort (the text vec still works) rather than failing.
export function getImageEmbedder(): ImageEmbedder | null {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  return {
    name: 'voyage',
    model: VOYAGE_MODEL,
    dim: IMAGE_EMBED_DIM,
    async embed(imageUrl: string): Promise<number[]> {
      const res = await fetch(VOYAGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: VOYAGE_MODEL,
          inputs: [{ content: [{ type: 'image_url', image_url: imageUrl }] }]
        })
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`voyage multimodal embed ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { data?: { embedding?: number[] }[] };
      const vec = json.data?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length !== IMAGE_EMBED_DIM) {
        throw new Error(`voyage multimodal embed: unexpected response (dim ${vec?.length ?? 'none'})`);
      }
      return vec;
    }
  };
}
