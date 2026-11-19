import { describe, expect, it } from 'vitest';
// Test env (DB URL, keys) comes from vitest.config.ts.
import { decrypt, encrypt, generatePairingCode, signDownload, stableExpiry, verifyDownload } from './crypto.js';

describe('encryption', () => {
  it('round-trips and produces distinct ciphertexts (fresh IV each time)', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const a = encrypt(secret);
    const b = encrypt(secret);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(secret);
    expect(decrypt(b)).toBe(secret);
  });

  it('rejects tampered ciphertext', () => {
    const enc = Buffer.from(encrypt('secret'), 'base64');
    enc[enc.length - 1]! ^= 0xff;
    expect(() => decrypt(enc.toString('base64'))).toThrow();
  });
});

describe('pairing codes', () => {
  it('uses only unambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });
});

describe('signed download URLs', () => {
  const media = 'aaaaaaaa-0000-0000-0000-000000000001';

  it('verifies a valid token and binds it to the media id', () => {
    const token = signDownload(media, 'screen-1', Math.floor(Date.now() / 1000) + 60);
    expect(verifyDownload(media, token)).toBe(true);
    expect(verifyDownload('bbbbbbbb-0000-0000-0000-000000000002', token)).toBe(false);
  });

  it('rejects expired and forged tokens', () => {
    const expired = signDownload(media, 'screen-1', Math.floor(Date.now() / 1000) - 1);
    expect(verifyDownload(media, expired)).toBe(false);
    expect(verifyDownload(media, 'screen-1.9999999999.forged')).toBe(false);
    expect(verifyDownload(media, 'garbage')).toBe(false);
  });

  it('hands out the same expiry (so the same URL) all through a bucket', () => {
    // Every manifest used to carry a brand-new token, so the URL text changed each
    // minute: browsers refetched whole videos and the web player restarted them.
    const ttl = 45 * 60;
    const bucket = 15 * 60;
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 1);
    const first = stableExpiry(ttl, bucket, t0);
    expect(stableExpiry(ttl, bucket, t0 + 60_000)).toBe(first);
    expect(stableExpiry(ttl, bucket, t0 + 13 * 60_000)).toBe(first);
    expect(stableExpiry(ttl, bucket, t0 + 15 * 60_000)).toBeGreaterThan(first);
  });

  it('never leaves less than ttl minus one bucket of life, and never exceeds ttl', () => {
    const ttl = 45 * 60;
    const bucket = 15 * 60;
    for (let offset = 0; offset < 3 * bucket; offset += 7) {
      const now = Date.UTC(2026, 0, 1, 12, 0, 0) + offset * 1000;
      const remaining = stableExpiry(ttl, bucket, now) - now / 1000;
      expect(remaining).toBeGreaterThanOrEqual(ttl - bucket);
      expect(remaining).toBeLessThanOrEqual(ttl);
    }
  });

  it('produces tokens that still verify', () => {
    const exp = stableExpiry(45 * 60);
    expect(verifyDownload(media, signDownload(media, 'screen-1', exp))).toBe(true);
  });

  it('signs the literal expiry field, not its numeric value', () => {
    // Verifying against Number(expiresAtS) instead of the raw field would accept
    // every one of these rewrites of a legitimately signed token, meaning the MAC
    // did not actually cover the bytes transmitted.
    const expires = Math.floor(Date.now() / 1000) + 60;
    const token = signDownload(media, 'screen-1', expires);
    const [subject, , mac] = token.split('.') as [string, string, string];
    for (const variant of [`0${expires}`, `+${expires}`, ` ${expires}`, `${expires}.0`]) {
      expect(verifyDownload(media, `${subject}.${variant}.${mac}`)).toBe(false);
    }
  });
});
