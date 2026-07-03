import { describe, expect, it } from 'vitest';
// Test env (DB URL, keys) comes from vitest.config.ts.
import { decrypt, encrypt, generatePairingCode, signDownload, verifyDownload } from './crypto.js';
import { sniffMediaType } from './uploads.js';

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
});

describe('upload sniffing (magic bytes, not extension)', () => {
  it('detects real types', () => {
    expect(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))?.mime).toBe('image/jpeg');
    expect(
      sniffMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))?.mime,
    ).toBe('image/png');
    expect(sniffMediaType(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP')]))?.mime).toBe('image/webp');
    expect(sniffMediaType(Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftypisom0000')]))?.kind).toBe(
      'video',
    );
  });

  it('rejects executables and unknown types regardless of claimed name', () => {
    expect(sniffMediaType(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00'))).toBeNull(); // PE .exe
    expect(sniffMediaType(Buffer.from('<html><script>x</script>'))).toBeNull();
  });
});
