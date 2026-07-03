import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8080),
  BASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32 bytes hex (64 hex chars)'),
  MEDIA_DIR: z.string().min(1),
  // When set, the API also serves the built admin UI from this directory
  // (single-container Docker deployments; the LXC install uses nginx instead).
  ADMIN_DIR: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(512),
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
export const SIGNED_URL_TTL_S = 6 * 3600;
