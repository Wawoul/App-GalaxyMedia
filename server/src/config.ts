import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8080),
  BASE_URL: z.string().url(),
  // Length alone would accept "CHANGE_ME" padded out, or 32 of the same
  // character. This signs every session and device token, so reject the
  // obviously-not-random cases rather than booting into a forgeable state.
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 chars')
    .refine((s) => new Set(s).size >= 8, 'JWT_SECRET looks like filler - use `openssl rand -hex 48`')
    .refine(
      (s) => !/change[_ -]?me|placeholder|secret{2,}|^password/i.test(s),
      'JWT_SECRET is a placeholder value - use `openssl rand -hex 48`',
    ),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32 bytes hex (64 hex chars)'),
  MEDIA_DIR: z.string().min(1),
  // Which address(es) may speak for the client in X-Forwarded-For: an IP/CIDR, or a
  // comma-separated list. The default (127.0.0.1) is the bundled nginx on the same
  // machine. A Docker install, where the proxy is another container, should set the
  // proxy's address or network (e.g. 172.18.0.0/16). Trusting by address matters:
  // the old "trust N hops" form lets anyone who can reach the app directly forge
  // their IP, and Fastify no longer honours it.
  TRUST_PROXY: z.string().min(1).default('127.0.0.1'),
  // When set, the API also serves the built admin UI from this directory
  // (single-container Docker deployments; the LXC install uses nginx instead).
  ADMIN_DIR: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(512),
  // Per-company storage cap in MB. 0 = unlimited (the default, so nothing changes
  // until an operator opts in).
  COMPANY_QUOTA_MB: z.coerce.number().int().min(0).default(0),
  // Uploads are refused when they would leave less than this free on the media disk.
  // One company filling the disk takes every other customer's screens down with it
  // (the database, the API and every download share it).
  MIN_FREE_DISK_MB: z.coerce.number().int().min(0).default(512),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Offline email alerts (all optional - alerts are disabled without SMTP_HOST + ALERT_EMAILS)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  ALERT_EMAILS: z.string().optional(), // comma-separated recipients
  OFFLINE_ALERT_MINUTES: z.coerce.number().int().min(1).default(5),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
export const PAIRING_CODE_TTL_S = 15 * 60;
export const PENDING_2FA_TTL_S = 5 * 60;
// Download URLs are HMAC-bound to one media id, but the file route can't check
// revocation (an <img>/player fetch carries no session), so this window is also
// how long an unpaired or moved screen keeps access to files it was already
// given. Kept well above a slow download of a large video, but far below the
// old 6h: players refresh the manifest every 60s, so they re-sign constantly.
export const SIGNED_URL_TTL_S = 45 * 60;
