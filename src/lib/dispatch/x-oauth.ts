/**
 * OAuth 1.0a request signing (HMAC-SHA1), per RFC 5849.
 *
 * Why 1.0a and not OAuth 2.0. Both are accepted by the two endpoints this
 * feature needs (`POST /2/media/upload` lists `OAuth2UserToken: media.write`
 * and `UserToken: []`; `POST /2/tweets` the same). OAuth 2.0 user context would
 * mean a three-legged authorization flow, a callback route, refresh-token
 * storage and a rotation path -- all of it to authorize one fixed account that
 * never changes. 1.0a signs each request from four static secrets with no
 * server-side state at all, which is the right shape for a single-account bot.
 *
 * Why hand-rolled rather than a dependency: this is ~70 lines against a frozen
 * 2010 spec, and the alternative is a transitive dependency tree handling our
 * posting credentials. The parts that are easy to get wrong are pinned by a
 * published test vector in tests/dispatch.test.ts, so a mistake here fails a
 * test rather than failing silently at 1pm against a live account.
 */
import { createHmac, randomBytes } from 'node:crypto';

export type XCredentials = {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

// RFC 3986 percent-encoding. encodeURIComponent leaves !*'() alone, and the
// signature base string is byte-compared on the far side -- so those five
// characters are the difference between a valid signature and a 401 that says
// nothing useful about why.
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

// Parameters are sorted by encoded key, ties broken by encoded value, then
// joined k=v with &. Sorting the raw strings instead would order them wrongly
// wherever encoding changes the collation.
export function normalizeParams(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export function signatureBaseString(
  method: string,
  baseUrl: string,
  params: Record<string, string>
): string {
  return [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(normalizeParams(params))
  ].join('&');
}

export function signingKey(consumerSecret: string, tokenSecret: string): string {
  return `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
}

export function hmacSha1Base64(base: string, key: string): string {
  return createHmac('sha1', key).update(base).digest('base64');
}

/**
 * Build the Authorization header for one request.
 *
 * `signedParams` must contain the query-string parameters, plus the body
 * parameters ONLY when the body is application/x-www-form-urlencoded. A
 * multipart/form-data or JSON body is deliberately NOT signed -- including it
 * produces a base string the server cannot reproduce, and both calls this
 * feature makes use one of those two body types.
 */
export function authorizationHeader(opts: {
  method: string;
  baseUrl: string;
  creds: XCredentials;
  signedParams?: Record<string, string>;
  // Injectable so the test vector can pin an exact expected signature; real
  // calls leave them out and get fresh random/clock values.
  nonce?: string;
  timestamp?: string;
}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: opts.creds.apiKey,
    oauth_nonce: opts.nonce ?? randomBytes(24).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: opts.creds.accessToken,
    oauth_version: '1.0'
  };

  const base = signatureBaseString(opts.method, opts.baseUrl, {
    ...(opts.signedParams ?? {}),
    ...oauthParams
  });
  const signature = hmacSha1Base64(
    base,
    signingKey(opts.creds.apiSecret, opts.creds.accessTokenSecret)
  );

  // Only the oauth_* parameters go in the header, never the request parameters
  // that were merely signed.
  const header: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  const parts = Object.keys(header)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(header[k]!)}"`);
  return `OAuth ${parts.join(', ')}`;
}
