// Visual identity embeddings of crop headshots, for character classification.
// A hosted multimodal model (Voyage) embeds the actual pixels into a vector so
// clustering can group by how a figure LOOKS, not how it was described -- the
// text-description embedding can't tell two different frogs (or two different
// anthropomorphic fish) apart. Kept here so the "no SDK calls outside src/lib/ai"
// rule holds; it's a plain fetch, no dependency. Key: VOYAGE_API_KEY (env).

const VOYAGE_URL = 'https://api.voyageai.com/v1/multimodalembeddings';
export const VOYAGE_MODEL = 'voyage-multimodal-3.5';
export const IMAGE_EMBED_DIM = 1024; // voyage-multimodal-3.5 default

// Why an embed failed, from the provider that knows its own status codes.
// `systemic` = nothing about this image caused it (bad key, rate limit, outage,
// misconfigured model), so the caller must back off and retry rather than blame
// the crop; `systemic: false` = this specific image is the problem (missing
// blob, unsupported/oversized pixels) and retrying it is pointless. Callers use
// the distinction to decide whether a failure counts against a crop's bounded
// attempt budget -- without it, one outage would burn every crop's budget and
// abandon the entire corpus.
export class ImageEmbedError extends Error {
  readonly status: number | null;
  readonly systemic: boolean;
  constructor(message: string, status: number | null, systemic: boolean) {
    super(message);
    this.name = 'ImageEmbedError';
    this.status = status;
    this.systemic = systemic;
  }
}

// Treat only the codes that name a fault in the REQUEST's image as per-crop.
// Everything else -- auth, quota, throttling, server errors, transport -- is
// assumed systemic, because charging a crop for someone else's outage is the
// expensive mistake and assuming systemic only costs a retry.
export function isCropFault(status: number): boolean {
  return status === 400 || status === 404 || status === 413 || status === 415 || status === 422;
}

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
      // Abort a stalled request: the worker's per-job timeout doesn't cancel an
      // in-flight fetch, so a hung Voyage call would otherwise keep burning the
      // cron tick after the job is marked failed.
      let res: Response;
      try {
        res = await fetch(VOYAGE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: VOYAGE_MODEL,
            inputs: [{ content: [{ type: 'image_url', image_url: imageUrl }] }]
          }),
          signal: AbortSignal.timeout(15_000)
        });
      } catch (err) {
        // Transport-level: abort/timeout, DNS, TLS. Nothing here is evidence
        // about the image itself, so it must not count against the crop.
        throw new ImageEmbedError(`voyage multimodal embed transport: ${String(err)}`, null, true);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ImageEmbedError(
          `voyage multimodal embed ${res.status}: ${body.slice(0, 200)}`,
          res.status,
          !isCropFault(res.status)
        );
      }
      const json = (await res.json()) as { data?: { embedding?: number[] }[] };
      const vec = json.data?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length !== IMAGE_EMBED_DIM) {
        // A 200 in the wrong shape means the model or its dimension changed
        // under us -- a config fault that every crop would hit identically.
        throw new ImageEmbedError(
          `voyage multimodal embed: unexpected response (dim ${vec?.length ?? 'none'})`,
          res.status,
          true
        );
      }
      return vec;
    }
  };
}
