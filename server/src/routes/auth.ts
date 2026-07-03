import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, randomToken, sha256Hex } from '../lib/crypto.js';
import { signPending2fa, signUserToken, verifyToken } from '../lib/tokens.js';
import { REFRESH_TOKEN_TTL_S } from '../config.js';
import { requireUser } from '../plugins/auth.js';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_BASE_S = 60; // doubles per extra failure

interface AuthUserRow {
  id: string;
  email: string;
  password_hash: string;
  level: 'msp' | 'company';
  role: 'admin' | 'editor' | 'viewer';
  totp_secret_enc: string | null;
  totp_enabled: boolean;
  recovery_codes: string[];
  disabled: boolean;
  failed_logins: number;
  locked_until: Date | null;
}

/** MSP accounts must use 2FA (SPEC §8). Company users: org toggle in Phase 2. */
function totpMandatory(user: Pick<AuthUserRow, 'level'>): boolean {
  return user.level === 'msp';
}

async function issueSession(userId: string): Promise<{ accessToken: string; refreshToken: string }> {
  const refreshToken = randomToken(32);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [userId, sha256Hex(refreshToken), REFRESH_TOKEN_TTL_S],
  );
  return { accessToken: signUserToken(userId), refreshToken };
}

export function authRoutes(app: FastifyInstance): void {
  // Tight rate limits: this is the unauthenticated attack surface.
  app.register(async (scope) => {
    scope.addHook('onRequest', scope.rateLimit({ max: 10, timeWindow: '1 minute' }));

    scope.post('/api/auth/login', async (req, reply) => {
      const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
      const { rows } = await query<AuthUserRow>('SELECT * FROM users WHERE email = $1', [body.email]);
      const user = rows[0];

      const fail = async (reason: string) => {
        audit({ action: 'auth.login_failed', ip: req.ip, detail: { email: body.email, reason } });
        // Uniform response: don't reveal whether the account exists.
        return reply.code(401).send({ error: 'invalid_credentials' });
      };

      if (!user || user.disabled) return fail('unknown_or_disabled');
      if (user.locked_until && user.locked_until > new Date()) return fail('locked');

      if (!(await argon2.verify(user.password_hash, body.password))) {
        const failures = user.failed_logins + 1;
        const lockSeconds =
          failures >= MAX_FAILED_LOGINS ? LOCKOUT_BASE_S * 2 ** (failures - MAX_FAILED_LOGINS) : 0;
        await query(
          `UPDATE users SET failed_logins = $2,
             locked_until = CASE WHEN $3 > 0 THEN now() + make_interval(secs => $3) ELSE NULL END
           WHERE id = $1`,
          [user.id, failures, lockSeconds],
        );
        return fail('bad_password');
      }

      await query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);

      if (user.totp_enabled) {
        return reply.send({ step: '2fa', pendingToken: signPending2fa(user.id, false) });
      }
      if (totpMandatory(user)) {
        return reply.send({ step: '2fa_enroll', pendingToken: signPending2fa(user.id, true) });
      }
      audit({ userId: user.id, action: 'auth.login', ip: req.ip });
      return reply.send({ step: 'done', ...(await issueSession(user.id)) });
    });

    // Begin TOTP enrollment (requires a pending token with enroll=true, or an
    // authenticated user enabling 2FA voluntarily - both paths land here).
    scope.post('/api/auth/2fa/enroll', async (req, reply) => {
      const body = z.object({ pendingToken: z.string() }).parse(req.body);
      const claims = verifyToken(body.pendingToken);
      if (!claims || claims.typ !== '2fa') return reply.code(401).send({ error: 'unauthenticated' });

      const secret = authenticator.generateSecret();
      await query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1 AND totp_enabled = false', [
        claims.sub,
        encrypt(secret),
      ]);
      const { rows } = await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [claims.sub]);
      const email = rows[0]?.email ?? 'user';
      return reply.send({
        secret,
        otpauthUrl: authenticator.keyuri(email, 'Galaxy Media', secret),
      });
    });

    // Activate 2FA by proving possession of the secret; returns recovery codes once.
    scope.post('/api/auth/2fa/activate', async (req, reply) => {
      const body = z.object({ pendingToken: z.string(), code: z.string().length(6) }).parse(req.body);
      const claims = verifyToken(body.pendingToken);
      if (!claims || claims.typ !== '2fa') return reply.code(401).send({ error: 'unauthenticated' });

      const { rows } = await query<AuthUserRow>('SELECT * FROM users WHERE id = $1', [claims.sub]);
      const user = rows[0];
      if (!user?.totp_secret_enc || user.totp_enabled) return reply.code(400).send({ error: 'bad_state' });
      if (!authenticator.check(body.code, decrypt(user.totp_secret_enc))) {
        return reply.code(401).send({ error: 'bad_code' });
      }

      const recoveryCodes = Array.from({ length: 8 }, () => randomToken(6));
      await query('UPDATE users SET totp_enabled = true, recovery_codes = $2 WHERE id = $1', [
        user.id,
        recoveryCodes.map(sha256Hex),
      ]);
      audit({ userId: user.id, action: 'auth.2fa_enrolled', ip: req.ip });
      return reply.send({ step: 'done', recoveryCodes, ...(await issueSession(user.id)) });
    });

    // Complete login with a TOTP code (or a recovery code).
    scope.post('/api/auth/2fa/verify', async (req, reply) => {
      const body = z.object({ pendingToken: z.string(), code: z.string().min(6).max(16) }).parse(req.body);
      const claims = verifyToken(body.pendingToken);
      if (!claims || claims.typ !== '2fa') return reply.code(401).send({ error: 'unauthenticated' });

      const { rows } = await query<AuthUserRow>('SELECT * FROM users WHERE id = $1', [claims.sub]);
      const user = rows[0];
      if (!user?.totp_enabled || !user.totp_secret_enc) return reply.code(400).send({ error: 'bad_state' });

      const codeHash = sha256Hex(body.code);
      const isRecovery = user.recovery_codes.includes(codeHash);
      const isTotp = !isRecovery && authenticator.check(body.code, decrypt(user.totp_secret_enc));
      if (!isTotp && !isRecovery) {
        audit({ userId: user.id, action: 'auth.2fa_failed', ip: req.ip });
        return reply.code(401).send({ error: 'bad_code' });
      }
      if (isTotp) {
        // Consume-once: a TOTP code stays valid for ~90s (window ±1), so an
        // observed code could otherwise open a second session. The WHERE makes
        // the check-and-set atomic even across concurrent attempts.
        const { rowCount } = await query(
          'UPDATE users SET totp_last_used = $2 WHERE id = $1 AND totp_last_used IS DISTINCT FROM $2',
          [user.id, codeHash],
        );
        if (!rowCount) {
          audit({ userId: user.id, action: 'auth.2fa_replayed', ip: req.ip });
          return reply.code(401).send({ error: 'bad_code' });
        }
      }
      if (isRecovery) {
        await query('UPDATE users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1', [
          user.id,
          codeHash,
        ]);
      }
      audit({ userId: user.id, action: 'auth.login', ip: req.ip, detail: { recovery: isRecovery } });
      return reply.send({ step: 'done', ...(await issueSession(user.id)) });
    });

    // Rotate a refresh token for a new session.
    scope.post('/api/auth/refresh', async (req, reply) => {
      const body = z.object({ refreshToken: z.string() }).parse(req.body);
      const hash = sha256Hex(body.refreshToken);
      const { rows } = await query<{ id: string; user_id: string }>(
        `UPDATE refresh_tokens SET revoked = true
         WHERE token_hash = $1 AND NOT revoked AND expires_at > now()
         RETURNING id, user_id`,
        [hash],
      );
      const row = rows[0];
      if (!row) return reply.code(401).send({ error: 'invalid_refresh' });
      return reply.send(await issueSession(row.user_id));
    });
  });

  app.post('/api/auth/logout', { preHandler: requireUser }, async (req, reply) => {
    const body = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {});
    if (body.refreshToken) {
      await query('UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1', [
        sha256Hex(body.refreshToken),
      ]);
    }
    audit({ userId: req.principal!.id, action: 'auth.logout', ip: req.ip });
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req, reply) => {
    const p = req.principal!;
    const { rows } = await query<{ email: string; display_name: string }>(
      'SELECT email, display_name FROM users WHERE id = $1',
      [p.id],
    );
    return reply.send({
      id: p.id,
      email: rows[0]?.email,
      displayName: rows[0]?.display_name,
      level: p.level,
      role: p.role,
      companyId: p.companyId,
      companyAccess: p.companyAccess,
    });
  });
}
