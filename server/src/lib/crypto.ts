import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';

const KEY = Buffer.from(config.ENCRYPTION_KEY, 'hex');

/** AES-256-GCM encrypt; output is base64(iv | ciphertext | tag). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString('base64');
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Constant-time comparison of two hex/base64 strings. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Opaque CSPRNG token (url-safe). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// Pairing codes avoid ambiguous characters (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// Largest multiple of the alphabet length that fits in a byte, so rejecting
// bytes at or above it removes the modulo bias (256 % 31 = 8, so bytes 0-7
// would otherwise be drawn from 9 values each vs 8 for the rest).
const REJECT_ABOVE = 256 - (256 % CODE_ALPHABET.length);

export function generatePairingCode(length = 6): string {
  let code = '';
  while (code.length < length) {
    for (const b of randomBytes(length - code.length)) {
      if (b >= REJECT_ABOVE) continue; // biased range - redraw
      code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return code;
}

/** HMAC-signed, expiring token for media downloads (usable in query strings). */
export function signDownload(mediaId: string, screenOrUserId: string, expiresAtS: number): string {
  const mac = createHmac('sha256', config.JWT_SECRET)
    .update(`${mediaId}.${screenOrUserId}.${expiresAtS}`)
    .digest('base64url');
  return `${screenOrUserId}.${expiresAtS}.${mac}`;
}

export function verifyDownload(mediaId: string, token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [subject, expiresAtS, mac] = parts as [string, string, string];
  const expires = Number(expiresAtS);
  if (!Number.isFinite(expires) || expires < Date.now() / 1000) return false;
  const expected = createHmac('sha256', config.JWT_SECRET)
    .update(`${mediaId}.${subject}.${expires}`)
    .digest('base64url');
  return safeEqual(mac, expected);
}
