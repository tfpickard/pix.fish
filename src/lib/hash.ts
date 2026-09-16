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

// Coarse geolocation from the CDN edge. Returns nulls in dev, or on any host
// that does not inject these headers, and every consumer stores the result in a
// nullable column, so an absent header degrades to "unknown" rather than
// failing a request.
//
// Cloudflare first, Vercel second. The Vercel names are kept as a fallback
// rather than deleted: they cost one absent-header lookup and they mean this
// function stays correct if the app is ever run behind Vercel again.
//
// The Cloudflare headers are NOT on by default. Only `CF-IPCountry` ships
// automatically; city and region need the "Add visitor location headers"
// managed transform enabled for the zone. Without it, country populates and
// the other two stay null, which is a legitimate state and not a bug to chase.
//
// Both edges URL-encode non-ascii city names (e.g. "S%C3%A3o%20Paulo"), so we
// always decode. We deliberately stop at city granularity; that is already
// ~10-100 mile resolution from the underlying IP-to-geo DB and satisfies the
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
  // First header that carries a value wins, so the Cloudflare and Vercel names
  // can coexist without either host needing to know about the other.
  const first = (...names: string[]): string | null => {
    for (const name of names) {
      const value = get(name);
      if (value) return value;
    }
    return null;
  };

  return {
    city: first('cf-ipcity', 'x-vercel-ip-city'),
    region: first('cf-region', 'x-vercel-ip-country-region'),
    country: first('cf-ipcountry', 'x-vercel-ip-country')
  };
}
