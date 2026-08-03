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

// The veto matches phrases where the REQUEST is the subject of the complaint,
// not bare words that merely appear in one. A substring like `model` is too
// blunt in both directions, and the false-veto direction is the dangerous one:
// "image dimensions exceed this model's limit" is unambiguous crop evidence, but
// a bare `model` marker would rule it systemic -- and a systemic verdict ABORTS
// the run rather than spending an attempt, so one such crop would wedge the
// whole drain permanently, with the crop's counter stuck at zero and every
// retry re-buying the same call. Exactly the never-self-healing shape this
// change exists to remove.
const REQUEST_FAULT_PATTERNS = [
  // The model is what is being complained about, either order.
  /\b(invalid|unknown|unsupported|unrecognized|deprecated|no such|missing)\s+model\b/,
  /\bmodel\b[^.;]{0,60}?\b(not supported|unsupported|not found|does not exist|deprecated|invalid|unknown)\b/,
  // The request envelope: schema, parameters, content type, credentials, spend.
  /\b(invalid|unknown|missing|unrecognized|malformed)\s+(parameter|field|argument|body|request|input)\b/,
  /\bapi[_ ]?key\b/,
  /\bauthoriz/,
  /\bcredential/,
  /\bquota\b/,
  /\bcredit/,
  /\bbilling\b/,
  /\brate limit/,
  /\binput_type\b/,
  /\bcontent[-_ ]type\b/,
  /application\/json/
];
// Crop blame requires the message to NAME THE IMAGE. This is one rule replacing
// a marker list, because the marker list kept failing the same way: every
// complaint word an image can attract is also a word a request can attract.
// "Unsupported Media Type" is the HTTP 415 reason phrase for our content type;
// "Request Entity Too Large" and "Payload Too Large" are 413's, about a body of
// a few hundred bytes. Each would convict every crop in the corpus for one
// request-level mistake. Demanding an explicit image subject makes that whole
// class of false positives impossible rather than removing them one at a time.
const IMAGE_SUBJECT = /\b(image|picture|photo|pixels?|thumbnail|media file)\b/;
// What is wrong WITH that image. Only consulted once the subject is established,
// so these can stay broad.
const IMAGE_COMPLAINTS = [
  'decode',
  'corrupt',
  'too large',
  'too small',
  'dimension',
  'width',
  'height',
  'resolution',
  'format',
  'unsupported',
  'invalid',
  'malformed',
  'empty'
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
  // Order matters: a request-level phrase vetoes, because "invalid model, expected
  // one of the multimodal image models" mentions the image without being about it.
  if (REQUEST_FAULT_PATTERNS.some((p) => p.test(text))) return false;
  // Nothing convicts a crop unless the message is about an image at all. This is
  // the gate that makes "Payload Too Large" and "Unsupported Media Type" -- both
  // about our request -- stay systemic without needing a rule per phrase.
  if (!IMAGE_SUBJECT.test(text)) return false;
  const gone = PERMANENTLY_GONE_MARKERS.some((m) => text.includes(m));
  // A failure to fetch our URL convicts the crop only when the blob is stated to
  // be gone. Everything else -- timeout, connection reset, a 5xx from the CDN --
  // is an outage wearing an image-shaped message, and outages must not be billed
  // to crops.
  if (FETCH_MARKERS.some((m) => text.includes(m))) return gone;
  // "image not found" with no fetch verb at all. The subject gate above already
  // established this is about the image, and a missing object is permanent, so
  // it must convict -- otherwise a dead blob reads as systemic, aborts the run
  // without ever spending an attempt, and wedges the drain on the same crop
  // forever. (Checked before the complaint list because "not found" is a
  // statement about existence, not about the pixels.)
  if (gone) return true;
  return IMAGE_COMPLAINTS.some((m) => text.includes(m));
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
