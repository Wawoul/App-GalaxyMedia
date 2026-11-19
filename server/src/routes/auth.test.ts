/**
 * Auth route tests: self-service password change, the forced change after an
 * admin reset, refresh-token rotation (and its grace window for concurrent tabs),
 * and the capped login lockout. Nothing here was covered before, and every one of
 * these is the sort of thing that breaks quietly.
 *
 * Needs Postgres: set TEST_DATABASE_URL (a throwaway database). Skips without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

const PASSWORD = 'Original-Password-123';
const NEW_PASSWORD = 'A-Brand-New-Password-456';

describeDb('auth routes', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  let signUserToken: (id: string) => string;
  let hash: string;
  let companyId = '';

  const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>;
  const login = (email: string, password = PASSWORD) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function makeUser(email: string, extra: { level?: string; role?: string; mustChange?: boolean } = {}) {
    const level = extra.level ?? 'company';
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, display_name, level, role, company_id, totp_enabled, must_change_password)
       VALUES ($1, $2, 'Tester', $3, $4, $5, $6, $7) RETURNING id`,
      [email, hash, level, extra.role ?? 'editor', level === 'company' ? companyId : null, level === 'msp', extra.mustChange ?? false],
    );
    return rows[0]!.id as string;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const argon2 = (await import('argon2')).default;
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    ({ signUserToken } = await import('../lib/tokens.js'));
    query = pool.query as typeof query;

    await migrate();
    await query('DELETE FROM refresh_tokens');
    await query('DELETE FROM users');
    await query('DELETE FROM companies');
    companyId = (await query(`INSERT INTO companies (name) VALUES ('AuthCo') RETURNING id`)).rows[0]!.id;
    hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });

    app = await buildServer();
    await app.ready();
    // Every request gets its own client address. The auth routes allow 10 requests
    // a minute per address, and these tests make far more than that - which is the
    // limiter working, not something to loosen for the sake of a test.
    let n = 0;
    const realInject = app.inject.bind(app) as (opts: object) => Promise<unknown>;
    app.inject = ((opts: object) =>
      realInject({ remoteAddress: `10.9.${Math.floor(n / 250)}.${(n++ % 250) + 1}`, ...opts })) as typeof app.inject;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('changing your own password', () => {
    it('needs the current password, a new one of 12+ characters, and a different one', async () => {
      const id = await makeUser('change-validate@auth.test');
      const headers = bearer(signUserToken(id));
      const post = (payload: object) => app.inject({ method: 'POST', url: '/api/auth/password', headers, payload });

      expect((await post({ currentPassword: 'wrong-wrong-wrong', newPassword: NEW_PASSWORD })).statusCode).toBe(401);
      expect((await post({ currentPassword: PASSWORD, newPassword: 'short' })).statusCode).toBe(400);
      expect((await post({ currentPassword: PASSWORD, newPassword: PASSWORD })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/auth/password', payload: {} })).statusCode).toBe(401);
    });

    it('limits guesses at the current password per address', async () => {
      // A stolen session must not be a free oracle for the owner's password.
      const id = await makeUser('change-limit@auth.test');
      const headers = bearer(signUserToken(id));
      const attempt = () =>
        app.inject({
          method: 'POST', url: '/api/auth/password', headers, remoteAddress: '10.77.0.1',
          payload: { currentPassword: 'wrong-wrong-wrong', newPassword: NEW_PASSWORD },
        });
      for (let i = 0; i < 10; i++) expect((await attempt()).statusCode, `attempt ${i + 1}`).toBe(401);
      expect((await attempt()).statusCode).toBe(429);
    });

    it('switches the password, ends every other session, and hands back a fresh one', async () => {
      await makeUser('change-ok@auth.test');
      const first = json(await login('change-ok@auth.test'));
      expect(first.step).toBe('done');

      const res = await app.inject({
        method: 'POST', url: '/api/auth/password', headers: bearer(first.accessToken),
        payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const fresh = json(res);
      expect(fresh.accessToken).toBeTruthy();
      expect(fresh.refreshToken).toBeTruthy();

      // The old session's refresh token is dead: a stolen one stops working too.
      const old = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: first.refreshToken } });
      expect(old.statusCode).toBe(401);
      // ...and the session we were handed back works.
      const ok = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: fresh.refreshToken } });
      expect(ok.statusCode).toBe(200);

      expect((await login('change-ok@auth.test', PASSWORD)).statusCode).toBe(401);
      expect((await login('change-ok@auth.test', NEW_PASSWORD)).statusCode).toBe(200);
    });
  });

  describe('forced password change after an admin reset', () => {
    it('blocks everything but the password change until it is done', async () => {
      const id = await makeUser('forced@auth.test', { mustChange: true });
      const headers = bearer(signUserToken(id));

      const blocked = await app.inject({ method: 'GET', url: '/api/companies', headers });
      expect(blocked.statusCode).toBe(403);
      expect(json(blocked).error).toBe('password_change_required');

      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
      expect(me.statusCode).toBe(200);
      expect(json(me).mustChangePassword).toBe(true);

      const changed = await app.inject({
        method: 'POST', url: '/api/auth/password', headers,
        payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(changed.statusCode).toBe(200);

      const after = await app.inject({ method: 'GET', url: '/api/companies', headers });
      expect(after.statusCode).toBe(200);
      expect(json(await app.inject({ method: 'GET', url: '/api/auth/me', headers })).mustChangePassword).toBe(false);
    });

    it('is set when an admin resets someone else\'s password, but not on your own', async () => {
      const admin = await makeUser('msp-admin@auth.test', { level: 'msp', role: 'admin' });
      const target = await makeUser('target@auth.test');
      const headers = bearer(signUserToken(admin));

      const reset = await app.inject({
        method: 'PATCH', url: `/api/users/${target}`, headers, payload: { password: 'Temporary-Reset-789' },
      });
      expect(reset.statusCode).toBe(200);
      expect((await query('SELECT must_change_password FROM users WHERE id = $1', [target])).rows[0]!.must_change_password).toBe(true);

      const own = await app.inject({
        method: 'PATCH', url: `/api/users/${admin}`, headers, payload: { password: 'My-Own-New-Password-1' },
      });
      expect(own.statusCode).toBe(200);
      expect((await query('SELECT must_change_password FROM users WHERE id = $1', [admin])).rows[0]!.must_change_password).toBe(false);
    });
  });

  describe('refresh-token rotation', () => {
    it('lets a token rotated a moment ago fail quietly instead of logging everyone out', async () => {
      // Two tabs restoring a session at once both present the same refresh token.
      // The loser used to trip theft detection, which revoked EVERY session the
      // user had - including the winner's brand-new one.
      await makeUser('grace@auth.test');
      const session = json(await login('grace@auth.test'));

      const winner = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: session.refreshToken } });
      expect(winner.statusCode).toBe(200);
      const winnerSession = json(winner);

      const loser = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: session.refreshToken } });
      expect(loser.statusCode).toBe(401);

      const stillGood = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: winnerSession.refreshToken } });
      expect(stillGood.statusCode).toBe(200);
    });

    it('still treats a replay long after rotation as theft and revokes the whole family', async () => {
      await makeUser('theft@auth.test');
      const session = json(await login('theft@auth.test'));
      const rotated = json(await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: session.refreshToken } }));

      // Pretend the rotation happened a minute ago, well outside the grace window.
      await query(`UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE revoked`);
      const replay = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: session.refreshToken } });
      expect(replay.statusCode).toBe(401);

      const victim = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: rotated.refreshToken } });
      expect(victim.statusCode).toBe(401);
    });

    it('does not give an explicitly revoked token (logout, disable) any grace', async () => {
      const id = await makeUser('revoked@auth.test');
      const session = json(await login('revoked@auth.test'));
      const rotated = json(await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: session.refreshToken } }));
      // An admin-style revocation: revoked, but with no rotation timestamp.
      await query('UPDATE refresh_tokens SET revoked = true, revoked_at = NULL WHERE user_id = $1', [id]);
      expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: rotated.refreshToken } })).statusCode).toBe(401);
      // Replaying the original is theft (no grace), so it must not resurrect anything either.
      expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: session.refreshToken } })).statusCode).toBe(401);
    });
  });

  describe('login lockout', () => {
    it('caps the lock at 15 minutes no matter how many failures have piled up', async () => {
      const id = await makeUser('lockcap@auth.test');
      await query('UPDATE users SET failed_logins = 60 WHERE id = $1', [id]);
      const res = await login('lockcap@auth.test', 'definitely-wrong-password');
      expect(res.statusCode).toBe(401);
      const { rows } = await query(
        `SELECT extract(epoch FROM (locked_until - now()))::int AS secs FROM users WHERE id = $1`, [id],
      );
      expect(rows[0]!.secs).toBeGreaterThan(0);
      expect(rows[0]!.secs).toBeLessThanOrEqual(15 * 60);
    });
  });
});
