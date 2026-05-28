import { createHmac } from 'crypto';

// Hash an IP address for storage. The raw IP is never persisted -- only the
// HMAC. IP_HASH_SALT must be set in env; in production, missing salt throws.
export function hashIp(ip: string): string {
  const salt = process.env.IP_HASH_SALT;
  if (!salt) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('IP_HASH_SALT env var is required in production');
    }
    console.warn('[pix.fish] IP_HASH_SALT not set -- using insecure fallback (dev only)');
    return createHmac('sha256', 'dev-only-insecure-fallback').update(ip).digest('hex').slice(0, 32);
  }
  return createHmac('sha256', salt).update(ip).digest('hex').slice(0, 32);
}

export function getRequestIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

// Coarse geolocation from Vercel's edge headers. Returns nulls in dev /
// non-Vercel hosts since the headers are absent there. Vercel URL-encodes
// city names with non-ascii characters (e.g. "S%C3%A3o%20Paulo"), so we
// always decode. We deliberately stop at city granularity; that's already
// ~10-100 mile resolution from the underlying IP→geo DB and satisfies the
// "no precise lat/lon stored" privacy posture.
export type RequestGeo = {
  city: string | null;
  region: string | null;
  country: string | null;
};

export function getRequestGeo(req: Request): RequestGeo {
  const get = (h: string): string | null => {
    const raw = req.headers.get(h);
    if (!raw) return null;
    try {
      const decoded = decodeURIComponent(raw).trim();
      return decoded || null;
    } catch {
      // Malformed % escape -- fall back to the raw value rather than
      // dropping it entirely, since most of the data is still useful.
      return raw.trim() || null;
    }
  };
  return {
    city: get('x-vercel-ip-city'),
    region: get('x-vercel-ip-country-region'),
    country: get('x-vercel-ip-country')
  };
}
