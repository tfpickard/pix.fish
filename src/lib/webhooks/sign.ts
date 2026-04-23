import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// 32 random bytes hex-encoded -> 64 chars. Shown to the owner exactly once
// at webhook creation; stored as-is since only the owner ever sees it.
export function newWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

export function signBody(secret: string, body: string): string {
  const mac = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${mac}`;
}

// Verifier is unused internally today but exported so the delivery handler
// tests and any future inbound-webhook features can share the same logic.
export function verifyBody(secret: string, body: string, signature: string): boolean {
  const expected = signBody(secret, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
