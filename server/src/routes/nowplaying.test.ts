/**
 * What the dashboard says is playing must match what the TV plays. The TV resolves its
 * schedule with lib/schedule.ts; the dashboard used to re-implement the rules in SQL,
 * and that copy quietly missed three of them:
 *   - bi-weekly (every Nth week) slots,
 *   - the early-morning tail of an overnight window (a Monday 22:00-02:00 slot still
 *     belongs to Monday at 00:30 on Tuesday),
 *   - timezones inherited from a group (the Schedule page promises them).
 * So the dashboard happily showed "Late" or "Biweekly" when the TV was playing
 * something else - or nothing.
 *
 * Needs Postgres: set TEST_DATABASE_URL (a throwaway database). Skips without it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

describeDb('dashboard "now playing" agrees with the TV', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  let signUserToken: (id: string) => string;
  let signDeviceToken: (screenId: string, jti: string) => string;
  let adminToken = '';
  let companyId = '';

  const at = (iso: string) => vi.setSystemTime(new Date(iso));

  async function makeScreen(timezone: string | null, groupId?: string) {
    const jti = crypto.randomUUID();
    const id = (
      await query(`INSERT INTO screens (company_id, name, timezone, device_token_jti, paired_at) VALUES ($1, 'S', $2, $3, now()) RETURNING id`, [companyId, timezone, jti])
    ).rows[0]!.id as string;
    if (groupId) await query('INSERT INTO screen_group_members (screen_id, group_id) VALUES ($1, $2)', [id, groupId]);
    return { id, jti };
  }
  const playlist = async (name: string) => (await query('INSERT INTO playlists (company_id, name) VALUES ($1, $2) RETURNING id', [companyId, name])).rows[0]!.id as string;
  async function assign(screenId: string, name: string, extra: Record<string, unknown> = {}) {
    const p = await playlist(name);
    const cols = { days_of_week: null, start_time: null, end_time: null, start_date: null, end_date: null, week_interval: 1, priority: 0, ...extra };
    await query(
      `INSERT INTO assignments (company_id, playlist_id, screen_id, priority, days_of_week, start_time, end_time, start_date, end_date, week_interval)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [companyId, p, screenId, cols.priority, cols.days_of_week, cols.start_time, cols.end_time, cols.start_date, cols.end_date, cols.week_interval],
    );
  }
  const nowPlaying = async (screenId: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/screens?companyId=${companyId}`, headers: { authorization: `Bearer ${adminToken}` } });
    return (JSON.parse(res.body) as { id: string; playlist_name: string | null }[]).find((s) => s.id === screenId)!.playlist_name;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    ({ signUserToken, signDeviceToken } = await import('../lib/tokens.js'));
    query = pool.query as typeof query;
    await migrate();
    await query('DELETE FROM assignments');
    await query('DELETE FROM playlists');
    await query('DELETE FROM screens');
    await query('DELETE FROM screen_groups');
    await query('DELETE FROM users');
    await query('DELETE FROM companies');
    companyId = (await query(`INSERT INTO companies (name) VALUES ('NowCo') RETURNING id`)).rows[0]!.id;
    adminToken = signUserToken(
      (await query(`INSERT INTO users (email, password_hash, display_name, level, role, totp_enabled) VALUES ('np@test.test', 'x', 'A', 'msp', 'admin', true) RETURNING id`)).rows[0]!.id,
    );
    app = await buildServer();
    await app.ready();
    // Only Date is faked: timers must keep running for the database and the server.
    vi.useFakeTimers({ toFake: ['Date'] });
  }, 60_000);

  afterEach(() => at('2026-01-01T12:00:00Z'));
  afterAll(async () => {
    vi.useRealTimers();
    await app?.close();
  });

  it('shows a bi-weekly slot only in the weeks it runs', async () => {
    const { id } = await makeScreen('UTC');
    // Starts Monday 5 Jan: runs that week, skips the next, runs the one after.
    await assign(id, 'Biweekly', { start_date: '2026-01-05', week_interval: 2 });
    at('2026-01-07T12:00:00Z'); // week 0
    expect(await nowPlaying(id)).toBe('Biweekly');
    at('2026-01-14T12:00:00Z'); // week 1: not this week
    expect(await nowPlaying(id)).toBeNull();
    at('2026-01-21T12:00:00Z'); // week 2
    expect(await nowPlaying(id)).toBe('Biweekly');
  });

  it("keeps an overnight slot on after midnight, on the day it started", async () => {
    const { id } = await makeScreen('UTC');
    // Mondays only, 22:00 to 02:00 the next morning.
    await assign(id, 'Late', { days_of_week: [1], start_time: '22:00', end_time: '02:00' });
    at('2026-01-05T23:00:00Z'); // Monday 23:00
    expect(await nowPlaying(id)).toBe('Late');
    at('2026-01-06T00:30:00Z'); // Tuesday 00:30 - still Monday's window
    expect(await nowPlaying(id)).toBe('Late');
    at('2026-01-06T03:00:00Z'); // Tuesday 03:00 - over
    expect(await nowPlaying(id)).toBeNull();
    at('2026-01-06T23:00:00Z'); // Tuesday 23:00 - not a Monday
    expect(await nowPlaying(id)).toBeNull();
  });

  it("uses the group's timezone for a screen that has none of its own", async () => {
    const group = (await query(`INSERT INTO screen_groups (company_id, name, timezone) VALUES ($1, 'Sydney shops', 'Australia/Sydney') RETURNING id`, [companyId])).rows[0]!.id as string;
    const { id } = await makeScreen(null, group);
    await assign(id, 'Morning', { start_time: '09:00', end_time: '10:00' });
    at('2026-01-05T22:30:00Z'); // 09:30 in Sydney (UTC+11)
    expect(await nowPlaying(id)).toBe('Morning');
    at('2026-01-05T09:30:00Z'); // 20:30 in Sydney
    expect(await nowPlaying(id)).toBeNull();
  });

  it("lets a screen's own timezone override its group's", async () => {
    const group = (await query(`INSERT INTO screen_groups (company_id, name, timezone) VALUES ($1, 'Tokyo shops', 'Asia/Tokyo') RETURNING id`, [companyId])).rows[0]!.id as string;
    const { id } = await makeScreen('UTC', group);
    await assign(id, 'Noon', { start_time: '12:00', end_time: '13:00' });
    at('2026-01-05T12:30:00Z'); // 12:30 UTC (21:30 in Tokyo)
    expect(await nowPlaying(id)).toBe('Noon');
  });

  it('gives the TV the same timezone the dashboard used', async () => {
    const group = (await query(`INSERT INTO screen_groups (company_id, name, timezone) VALUES ($1, 'Berlin shops', 'Europe/Berlin') RETURNING id`, [companyId])).rows[0]!.id as string;
    const { id, jti } = await makeScreen(null, group);
    const res = await app.inject({ method: 'GET', url: '/api/device/manifest', headers: { authorization: `Bearer ${signDeviceToken(id, jti)}` } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).screen.timezone).toBe('Europe/Berlin');
  });
});
