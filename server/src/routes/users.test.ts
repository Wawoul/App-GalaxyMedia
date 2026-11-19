/**
 * User management edge cases found in review.
 *
 * Needs Postgres: set TEST_DATABASE_URL (a throwaway database). Skips without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

describeDb('user management', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  let signUserToken: (id: string) => string;
  let companyId = '';

  const mspAdmin = async (email: string, disabled = false) =>
    (await query(
      `INSERT INTO users (email, password_hash, display_name, level, role, totp_enabled, disabled)
       VALUES ($1, 'x', 'Admin', 'msp', 'admin', true, $2) RETURNING id`,
      [email, disabled],
    )).rows[0]!.id as string;
  const as = (id: string) => ({ authorization: `Bearer ${signUserToken(id)}` });

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    ({ signUserToken } = await import('../lib/tokens.js'));
    query = pool.query as typeof query;
    await migrate();
    await query('DELETE FROM users');
    await query('DELETE FROM companies');
    companyId = (await query(`INSERT INTO companies (name) VALUES ('UserCo') RETURNING id`)).rows[0]!.id;
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const create = (adminId: string, email: string) =>
    app.inject({
      method: 'POST', url: '/api/users', headers: as(adminId),
      payload: { email, password: 'A-Long-Enough-Password-1', displayName: 'New', level: 'company', role: 'viewer', companyId },
    });

  it('answers a duplicate email with 409, not a 500', async () => {
    const admin = await mspAdmin('dup-admin@users.test');
    expect((await create(admin, 'someone@users.test')).statusCode).toBe(201);
    const again = await create(admin, 'someone@users.test');
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.body).error).toBe('email_in_use');
    // Emails are case-insensitive (citext), so this is the same address.
    expect((await create(admin, 'SomeOne@Users.Test')).statusCode).toBe(409);
  });

  it('allows deleting a DISABLED admin while one active admin remains', async () => {
    // The guard counted active admins and refused whenever that was 1 - even when
    // the account being deleted was already disabled and so not part of that count.
    // With a single active admin, a retired (disabled) one could never be removed.
    await query('DELETE FROM users');
    const active = await mspAdmin('keeper@users.test');
    const retired = await mspAdmin('retired@users.test', true);
    const res = await app.inject({ method: 'DELETE', url: `/api/users/${retired}`, headers: as(active) });
    expect(res.statusCode).toBe(200);
    expect((await query('SELECT 1 FROM users WHERE id = $1', [retired])).rows).toHaveLength(0);
  });

  it('still protects the active admins: deleting yourself is refused', async () => {
    await query('DELETE FROM users');
    const only = await mspAdmin('solo@users.test');
    const res = await app.inject({ method: 'DELETE', url: `/api/users/${only}`, headers: as(only) });
    expect(res.statusCode).toBe(400);
    expect((await query('SELECT 1 FROM users WHERE id = $1', [only])).rows).toHaveLength(1);
  });
});
