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

// NO status code identifies the image, so none of them alone can blame a crop.
// That falls out of how this call is shaped: we send a small JSON body carrying
// a URL, and Voyage fetches the pixels server-side. So the classic "your content
// is bad" codes are all describing OUR REQUEST, not the crop -- 415 is about the
// application/json content type, 422 about the body schema, 413 about a payload
// that is a few hundred bytes, 404 about the endpoint. Every one of those is
// identical for every crop in the corpus, so trusting the status would let one
// config mistake charge all 1798 crops an attempt and abandon the lot in three
// sweeps.
//
// Hence: an ambiguous 4xx is decided by the BODY. Blame the crop only when the
// message is about the image, and never when it names a request-level subject.
const AMBIGUOUS_STATUSES = new Set([400, 413, 415, 422]);
const REQUEST_FAULT_MARKERS = [
  'model',
  'api key',
  'api_key',
  'apikey',
  'authoriz',
  'credential',
  'quota',
  'credit',
  'billing',
  'rate limit',
  'parameter',
  'input_type',
  'json'
];
const IMAGE_FAULT_MARKERS = [
  'image',
  'decode',
  'corrupt',
  'pixel',
  // NB: "unsupported media type" is deliberately absent -- it is the literal
  // HTTP 415 reason phrase, so a bare request-level rejection of our
  // application/json content type would read as evidence about the crop. A
  // genuinely unusable format still matches via 'image' or 'decode'.
  'too large',
  'dimension',
  'width',
  'height'
];

// "Could not download the image" is NOT an image fault by itself. Voyage fetches
// our Blob URL, so a Blob/CDN outage, a timeout, or a 5xx on their fetch path
// produces that same sentence for every crop in the corpus -- three sweeps of it
// and the whole corpus is abandoned for something that fixed itself in ten
// minutes. A fetch failure only convicts the crop when the message establishes
// the URL is permanently gone.
const FETCH_MARKERS = ['download', 'fetch', 'retriev', 'could not load', 'unable to load'];
const PERMANENTLY_GONE_MARKERS = ['404', 'not found', 'no such', 'does not exist', 'deleted'];

// Everything not listed as ambiguous -- 401/403 (auth), 429 (throttle), 404
// (the endpoint moved), 5xx -- is systemic outright and never reaches the body
// check. An ambiguous status with an unreadable or unrecognized body is systemic
// too: the default has to be the cheap mistake, and assuming systemic only costs
// a retry while assuming crop-fault costs the corpus.
export function isCropFault(status: number, body = ''): boolean {
  if (!AMBIGUOUS_STATUSES.has(status)) return false;
  const text = body.toLowerCase();
  // Order matters: a request-level marker vetoes, because "invalid model, expected
  // one of the multimodal image models" mentions the image without being about it.
  if (REQUEST_FAULT_MARKERS.some((m) => text.includes(m))) return false;
  // A failure to fetch our URL convicts the crop only when the blob is stated to
  // be gone. Everything else -- timeout, connection reset, a 5xx from the CDN --
  // is an outage wearing an image-shaped message, and outages must not be billed
  // to crops.
  if (FETCH_MARKERS.some((m) => text.includes(m))) {
    return PERMANENTLY_GONE_MARKERS.some((m) => text.includes(m));
  }
  return IMAGE_FAULT_MARKERS.some((m) => text.includes(m));
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
          !isCropFault(res.status, body)
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
