import { describe, expect, test } from 'bun:test';
import { hashPassword, verifyPassword } from '../src/lib/password';

// Security-critical round-trip + malformed-input behavior. Guards against a
// regression if the scrypt params or the stored `scrypt$<salt>$<hash>` format
// ever change. Pure, infra-free -- no DB, no server -- like the rest of the suite.
describe('password hashing', () => {
  test('verifies a correct password against its own hash', () => {
    const hash = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  test('rejects a wrong or empty password', () => {
    const hash = hashPassword('s3cret-pw');
    expect(verifyPassword('S3cret-pw', hash)).toBe(false); // case-sensitive
    expect(verifyPassword('s3cret-pw ', hash)).toBe(false); // trailing space
    expect(verifyPassword('', hash)).toBe(false);
  });

  test('salts each hash: same password produces distinct digests that both verify', () => {
    const a = hashPassword('same-pw');
    const b = hashPassword('same-pw');
    expect(a).not.toBe(b);
    expect(verifyPassword('same-pw', a)).toBe(true);
    expect(verifyPassword('same-pw', b)).toBe(true);
  });

  test('stored format is scrypt$<salt-hex>$<hash-hex>', () => {
    const parts = hashPassword('fmt').split('$');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toMatch(/^[0-9a-f]+$/);
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });

  test('malformed stored values return false and never throw', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'not-a-hash',
      'bcrypt$deadbeef$cafe', // wrong algorithm tag
      'scrypt$deadbeef', // too few segments
      'scrypt$$', // empty salt + hash
      'scrypt$zzz$zzz' // non-hex payload
    ]) {
      expect(verifyPassword('pw', bad as string | null | undefined)).toBe(false);
    }
  });
});
