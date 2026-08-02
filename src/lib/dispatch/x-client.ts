/**
 * The X posting client. Two calls: upload the specimen image, then create the
 * post referencing it.
 *
 * Endpoint choice is forced rather than preferred. The v1.1 media endpoints on
 * upload.twitter.com were sunset on 9 June 2025, so `POST /2/media/upload` is
 * the only way to attach an image now. Images fit the single-request form
 * (media + media_category), so the chunked INIT/APPEND/FINALIZE dance that the
 * v2 docs lead with is not needed here -- that path is for video.
 *
 * Everything is bounded and nothing retries. A failure returns a structured
 * error the handler turns into a `post_failed` skip, which is a correct outcome:
 * the day is claimed, the log records why, and nothing is posted. Retrying a
 * post is the one thing this feature must never do, because a retry that
 * succeeds after a timeout has already posted.
 */
import { authorizationHeader, type XCredentials } from './x-oauth';
import { MEDIA_UPLOAD_TIMEOUT_MS, POST_TIMEOUT_MS, MAX_MEDIA_BYTES } from './config';

const MEDIA_UPLOAD_URL = 'https://api.x.com/2/media/upload';
const CREATE_POST_URL = 'https://api.x.com/2/tweets';

export type XPostResult =
  | { ok: true; postId: string; url: string }
  // `indeterminate` means the request left this process and no usable answer came
  // back -- a timeout, an abort, a socket error. X may well have accepted it, so
  // the post may be public. Distinguishing that from a definite rejection (an
  // HTTP error we actually read) is the difference between the log saying "no
  // post" truthfully and saying it when a post exists.
  | { ok: false; reason: string; indeterminate: boolean };

// Which of the four credential names are absent from the environment. Names
// only, never values -- but names are the whole diagnostic: "credentials
// missing" is unactionable when four variables can each cause it, and the
// difference between a typo, a wrong scope and a missing var is exactly which
// subset comes back.
export const X_CREDENTIAL_NAMES = [
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_TOKEN_SECRET'
] as const;

export function missingXCredentialNames(): string[] {
  return X_CREDENTIAL_NAMES.filter((n) => !process.env[n]);
}

// Credentials come from the environment rather than provider_keys: these are the
// SITE's posting identity, not a per-user BYO credential, and there is exactly
// one account. Returning null (rather than throwing) keeps "not configured" a
// skip the caller decides about, matching how getProvider/getEmbedder behave.
export function getXCredentials(): XCredentials | null {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) return null;
  return { apiKey, apiSecret, accessToken, accessTokenSecret };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Bound the response body we read from an error. X returns HTML from its edge
// on some failures, and putting an unbounded page into an event payload would
// make the log unreadable and the row large.
async function errorDetail(res: Response): Promise<string> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 400).replace(/\s+/g, ' ').trim();
  } catch {
    body = '(body unreadable)';
  }
  return `HTTP ${res.status}${body ? `: ${body}` : ''}`;
}

/**
 * Fetch the specimen image from blob storage. Bounded by size as well as time:
 * the post is refused rather than truncated if the image is too large for X,
 * because a truncated upload would fail server-side anyway and cost the call.
 */
export async function fetchSpecimenImage(
  blobUrl: string,
  timeoutMs: number
): Promise<{ ok: true; bytes: Uint8Array; mime: string } | { ok: false; reason: string }> {
  try {
    const res = await fetch(blobUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, reason: `image fetch failed: ${await errorDetail(res)}` };

    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_MEDIA_BYTES) {
      return { ok: false, reason: `image is ${declared} bytes, over the ${MAX_MEDIA_BYTES} limit` };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    // Re-check after reading: content-length can be absent or wrong, and the
    // declared check above is only an early out.
    if (buf.byteLength > MAX_MEDIA_BYTES) {
      return { ok: false, reason: `image is ${buf.byteLength} bytes, over the ${MAX_MEDIA_BYTES} limit` };
    }
    if (buf.byteLength === 0) return { ok: false, reason: 'image is empty' };

    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
    return { ok: true, bytes: buf, mime };
  } catch (err) {
    return { ok: false, reason: `image fetch failed: ${errText(err)}` };
  }
}

// X distinguishes GIFs from stills: a GIF sent as `tweet_image` can be rejected
// or handled as the wrong media type, turning an otherwise valid dispatch into a
// post_failed. The upload route accepts image/gif, so a GIF specimen really can
// reach here.
export function mediaCategoryFor(mime: string): 'tweet_gif' | 'tweet_image' {
  return mime.toLowerCase() === 'image/gif' ? 'tweet_gif' : 'tweet_image';
}

/**
 * Single-request image upload. The body is multipart/form-data, so per RFC 5849
 * none of it is signed -- the Authorization header covers the oauth_* params
 * only. Signing the body here is the classic way to get an inscrutable 401.
 */
export async function uploadMedia(
  creds: XCredentials,
  bytes: Uint8Array,
  mime: string
): Promise<{ ok: true; mediaId: string } | { ok: false; reason: string }> {
  const form = new FormData();
  // Copy into a fresh ArrayBuffer: Blob's type does not accept the
  // SharedArrayBuffer-backed view that Uint8Array can carry.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  form.append('media', new Blob([ab], { type: mime }), 'specimen');
  form.append('media_category', mediaCategoryFor(mime));
  form.append('media_type', mime);

  try {
    const res = await fetch(MEDIA_UPLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: authorizationHeader({
          method: 'POST',
          baseUrl: MEDIA_UPLOAD_URL,
          creds
        })
      },
      body: form,
      signal: AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS)
    });
    if (!res.ok) return { ok: false, reason: `media upload failed: ${await errorDetail(res)}` };

    const json = (await res.json()) as { data?: { id?: string }; id?: string };
    // The v2 response nests under `data`; accept a bare `id` too rather than
    // failing on a shape difference after the upload has already been paid for.
    const mediaId = json.data?.id ?? json.id;
    if (!mediaId) return { ok: false, reason: 'media upload returned no media id' };
    return { ok: true, mediaId: String(mediaId) };
  } catch (err) {
    return { ok: false, reason: `media upload failed: ${errText(err)}` };
  }
}


/**
 * Whether an HTTP error status leaves the post's existence unknown.
 *
 * A readable response is not automatically a definite answer. A 4xx is: the
 * request was refused on the way in -- bad auth, bad media id, duplicate content
 * -- so nothing became public and the log can say "no post" truthfully. A 5xx is
 * not. It says the far side broke, and says nothing about whether it broke
 * before or after creating the post; X publishes no side-effect-free guarantee
 * for its own errors.
 *
 * The asymmetry is what decides this. Calling a 5xx definite releases the
 * specimen in listDispatchedImageIds() and lets the same image go out a second
 * time -- the exact duplicate this path exists to prevent. Calling it
 * indeterminate costs one specimen and one honest warning on the review page.
 */
export function statusIsIndeterminate(status: number): boolean {
  return status >= 500;
}

/**
 * Create the post. JSON body, so again nothing but the oauth_* params is signed.
 *
 * There is no `possibly_sensitive` field on POST /2/tweets -- it existed on the
 * v1.1 statuses/update endpoint and has no v2 equivalent. Per-post sensitivity
 * is therefore not expressible here; see LIVE_ALLOW_NSFW in config.ts for how
 * that constrains which specimens may go out live.
 */
export async function createPost(
  creds: XCredentials,
  opts: { text: string; mediaId: string; madeWithAi?: boolean }
): Promise<XPostResult> {
  const body: Record<string, unknown> = {
    text: opts.text,
    media: { media_ids: [opts.mediaId] }
  };
  // Only asserted when explicitly configured. Sending `false` is a claim about
  // the image's provenance just as much as `true` is, and this code does not
  // know how any given specimen was made.
  if (opts.madeWithAi !== undefined) body.made_with_ai = opts.madeWithAi;

  try {
    const res = await fetch(CREATE_POST_URL, {
      method: 'POST',
      headers: {
        Authorization: authorizationHeader({
          method: 'POST',
          baseUrl: CREATE_POST_URL,
          creds
        }),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS)
    });
    if (!res.ok) {
      const detail = await errorDetail(res);
      const unknown = statusIsIndeterminate(res.status);
      return {
        ok: false,
        reason: unknown ? `post outcome unknown (server error): ${detail}` : `post rejected: ${detail}`,
        indeterminate: unknown
      };
    }

    let json: { data?: { id?: string } };
    try {
      json = (await res.json()) as { data?: { id?: string } };
    } catch (err) {
      // 2xx whose body we could not read. The post almost certainly exists; we
      // just cannot name it.
      return {
        ok: false,
        reason: `post accepted but the response was unreadable: ${errText(err)}`,
        indeterminate: true
      };
    }
    const postId = json.data?.id;
    if (!postId) {
      return { ok: false, reason: 'post accepted but returned no id', indeterminate: true };
    }
    return { ok: true, postId, url: `https://x.com/i/web/status/${postId}` };
  } catch (err) {
    // Threw before or after the request was written -- fetch does not tell us
    // which, so this has to be treated as possibly-published.
    return { ok: false, reason: `post outcome unknown: ${errText(err)}`, indeterminate: true };
  }
}
