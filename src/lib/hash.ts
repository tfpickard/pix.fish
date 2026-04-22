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
