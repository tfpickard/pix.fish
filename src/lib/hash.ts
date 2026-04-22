import { createHmac } from 'crypto';

// Hash an IP address for storage. The raw IP is never persisted -- only the
// HMAC. IP_HASH_SALT must be set in env; if missing we fall back to a fixed
// salt that at least prevents trivial reversal.
export function hashIp(ip: string): string {
  const salt = process.env.IP_HASH_SALT ?? 'pix.fish-default-salt-change-me';
  return createHmac('sha256', salt).update(ip).digest('hex').slice(0, 32);
}

export function getRequestIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}
