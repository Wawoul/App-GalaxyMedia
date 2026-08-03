/**
 * Integration tests for the guarantee the whole product rests on: one company's
 * users can never reach another's data, and an unauthenticated caller can reach
 * almost nothing. SPEC §8 claims these are "verified by tests" - until this file
 * that was only true of the pure permission helpers, not the actual routes.
 *
 * These drive the real Fastify app against a real database via app.inject().
 * They need Postgres: set TEST_DATABASE_URL (a throwaway database - the suite
 * migrates it and deletes its rows). Without it the whole file skips rather
 * than failing, so `npm test` stays green on a machine with no database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

describeDb('cross-tenant isolation', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, string>[] }>;
  // Two companies that must never see each other, plus one admin each.
  const alpha = { companyId: '', screenId: '', token: '' };
  const beta = { companyId: '', screenId: '', token: '' };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    const { signUserToken } = await import('../lib/tokens.js');
    query = pool.query as typeof query;

    await migrate();
    // Clean slate: order matters, children before parents.
    await query('DELETE FROM proof_of_play');
    await query('DELETE FROM refresh_tokens');
    await query('DELETE FROM screens');
    await query('DELETE FROM media');
    await query('DELETE FROM users');
    await query('DELETE FROM companies');

    for (const [name, fixture] of [['Alpha', alpha], ['Beta', beta]] as const) {
      const company = await query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name]);
      fixture.companyId = company.rows[0]!.id;
      const user = await query(
        `INSERT INTO users (email, password_hash, display_name, level, role, company_id, totp_enabled)
         VALUES ($1, 'x', $2, 'company', 'admin', $3, true) RETURNING id`,
        [`admin@${name.toLowerCase()}.test`, `${name} Admin`, fixture.companyId],
      );
      fixture.token = signUserToken(user.rows[0]!.id);
      const screen = await query(
        'INSERT INTO screens (company_id, name, timezone) VALUES ($1, $2, $3) RETURNING id',
        [fixture.companyId, `${name} Screen`, 'UTC'],
      );
      fixture.screenId = screen.rows[0]!.id;
    }

    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    // Close the app only - the pg pool is module-level and shared with the
    // suite below, so ending it here would break that one.
    await app?.close();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("lists only the caller's own screens", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/screens', headers: auth(alpha.token) });
    expect(res.statusCode).toBe(200);
    const names = (res.json() as { name: string }[]).map((s) => s.name);
    expect(names).toContain('Alpha Screen');
    expect(names).not.toContain('Beta Screen');
  });

  it("refuses to read another company's screen by id", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/screens/${beta.screenId}`,
      headers: auth(alpha.token),
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("refuses to modify another company's screen", async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/screens/${beta.screenId}`,
      headers: auth(alpha.token),
      payload: { name: 'pwned' },
    });
    expect([403, 404]).toContain(res.statusCode);
    const after = await query('SELECT name FROM screens WHERE id = $1', [beta.screenId]);
    expect(after.rows[0]!.name).toBe('Beta Screen');
  });

  it("refuses to delete another company's screen", async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/screens/${beta.screenId}`,
      headers: auth(alpha.token),
    });
    expect([403, 404]).toContain(res.statusCode);
    const after = await query('SELECT id FROM screens WHERE id = $1', [beta.screenId]);
    expect(after.rows).toHaveLength(1); // still there
  });

  it('cannot create a screen inside another company by passing its id', async () => {
    // The classic mass-assignment attempt: company_id must come from the
    // principal, never from the body.
    const res = await app.inject({
      method: 'POST',
      url: '/api/screens',
      headers: auth(alpha.token),
      payload: { name: 'smuggled', timezone: 'UTC', companyId: beta.companyId },
    });
    const smuggled = await query('SELECT company_id FROM screens WHERE name = $1', ['smuggled']);
    for (const row of smuggled.rows) expect(row.company_id).not.toBe(beta.companyId);
    if (res.statusCode < 300) expect(smuggled.rows[0]?.company_id).toBe(alpha.companyId);
  });

  it("does not leak another company's screens through the companyId filter", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/screens?companyId=${beta.companyId}`,
      headers: auth(alpha.token),
    });
    if (res.statusCode === 200) {
      const names = (res.json() as { name: string }[]).map((s) => s.name);
      expect(names).not.toContain('Beta Screen');
    } else {
      expect(res.statusCode).toBe(403);
    }
  });
});

describeDb('unauthenticated access', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('../db/migrate.js');
    const { buildServer } = await import('../index.js');
    await migrate();
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    // Last suite in the file: release the shared pool so vitest can exit.
    const pool = await import('../db/pool.js');
    await pool.pool.end();
  });

  it('serves health without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it.each([
    '/api/screens',
    '/api/companies',
    '/api/users',
    `/api/companies/${crypto.randomUUID()}/playlists`,
    `/api/companies/${crypto.randomUUID()}/layouts`,
    `/api/companies/${crypto.randomUUID()}/media`,
    `/api/companies/${crypto.randomUUID()}/reports/proof-of-play`,
    '/api/settings/alerts',
  ])('rejects %s without a token', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    // 401 before anything else: auth must be decided ahead of existence, or a
    // stranger could probe which company ids are real.
    expect(res.statusCode).toBe(401);
  });

  it('rejects a garbage bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/screens',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a device token on a human-only route', async () => {
    // A stolen TV token must not open the admin API (SPEC §8).
    const { signDeviceToken } = await import('../lib/tokens.js');
    const res = await app.inject({
      method: 'GET',
      url: '/api/screens',
      headers: { authorization: `Bearer ${signDeviceToken(crypto.randomUUID(), 'jti')}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a media download with no token at all', async () => {
    // 400 from schema validation - the token query param is required, so this
    // never reaches the file. Either way nothing is served.
    const res = await app.inject({ method: 'GET', url: `/api/media/${crypto.randomUUID()}/file` });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a media download with a forged token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/media/${crypto.randomUUID()}/file?token=someone.9999999999.forged`,
    });
    expect(res.statusCode).toBe(401);
  });
});
