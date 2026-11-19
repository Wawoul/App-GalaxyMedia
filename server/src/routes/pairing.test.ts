/**
 * Pairing rate limits. A TV on the pairing screen polls every 5 seconds (12 a
 * minute) and a site often pairs several TVs at once from ONE public address.
 * The old limit was a single 12-a-minute budget per address shared by register and
 * poll, so one TV sat exactly on the limit and a second made both throttle - and a
 * throttled TV answered by registering again, so its on-screen code changed under
 * the installer's hands.
 *
 * Needs Postgres: set TEST_DATABASE_URL (a throwaway database). Skips without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

describeDb('device pairing rate limits', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  let n = 0;
  /** A fresh "site" address per test, so one test's traffic never counts against another's. */
  const site = () => `10.20.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    query = pool.query as typeof query;
    await migrate();
    await query('DELETE FROM pairing_requests');
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await query('DELETE FROM pairing_requests');
    await app?.close();
  });

  const register = (ip: string) => app.inject({ method: 'POST', url: '/api/device/register', remoteAddress: ip });
  const poll = (ip: string, id: string) => app.inject({ method: 'GET', url: `/api/device/register/${id}`, remoteAddress: ip });
  const idOf = (res: { body: string }) => (JSON.parse(res.body) as { requestId: string }).requestId;

  it('lets one TV poll every 5 seconds for a minute without being throttled', async () => {
    const ip = site();
    const id = idOf(await register(ip));
    for (let i = 0; i < 20; i++) {
      expect((await poll(ip, id)).statusCode, `poll ${i + 1}`).toBe(200);
    }
  });

  it('gives each pairing request its own poll budget, even from one shared address', async () => {
    const ip = site();
    const a = idOf(await register(ip));
    const b = idOf(await register(ip));
    // TV "a" is hammering (a stuck loop); TV "b" beside it must be unaffected.
    for (let i = 0; i < 30; i++) expect((await poll(ip, a)).statusCode).toBe(200);
    expect((await poll(ip, a)).statusCode).toBe(429);
    expect((await poll(ip, b)).statusCode).toBe(200);
  });

  it('lets a whole site register its TVs at once, then stops a flood', async () => {
    const ip = site();
    for (let i = 0; i < 30; i++) expect((await register(ip)).statusCode, `register ${i + 1}`).toBe(201);
    expect((await register(ip)).statusCode).toBe(429);
  });

  it('tells a throttled TV to wait rather than failing it as unknown', async () => {
    const ip = site();
    const id = idOf(await register(ip));
    for (let i = 0; i < 30; i++) await poll(ip, id);
    const limited = await poll(ip, id);
    expect(limited.statusCode).toBe(429);
    // The request itself is still valid: the TV must keep its code and try again.
    expect((await query('SELECT 1 FROM pairing_requests WHERE id = $1', [id])).rows).toHaveLength(1);
  });
});
