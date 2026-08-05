/**
 * Integration tests for the code paths nothing routinely exercises - screen
 * moves, config import, and schedule resolution. Every bug found in the last
 * review round lived in one of these, precisely because no test drove them and
 * normal day-to-day use rarely does either.
 *
 * Needs Postgres: set TEST_DATABASE_URL (a throwaway database). Skips without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

describeDb('screen move between companies', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, string>[] }>;
  let mspToken = '';
  const alpha = { companyId: '', screenId: '' };
  const beta = { companyId: '' };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    const { signUserToken } = await import('../lib/tokens.js');
    query = pool.query as typeof query;

    await migrate();
    await query('DELETE FROM proof_of_play');
    await query('DELETE FROM screens');
    await query('DELETE FROM users');
    await query('DELETE FROM companies');

    const a = await query('INSERT INTO companies (name) VALUES ($1) RETURNING id', ['MoveAlpha']);
    alpha.companyId = a.rows[0]!.id;
    const b = await query('INSERT INTO companies (name) VALUES ($1) RETURNING id', ['MoveBeta']);
    beta.companyId = b.rows[0]!.id;

    // An MSP admin can see both companies, which is what a move requires.
    const user = await query(
      `INSERT INTO users (email, password_hash, display_name, level, role, totp_enabled)
       VALUES ('msp@move.test', 'x', 'MSP', 'msp', 'admin', true) RETURNING id`,
    );
    mspToken = signUserToken(user.rows[0]!.id);

    const screen = await query(
      'INSERT INTO screens (company_id, name, timezone) VALUES ($1, $2, $3) RETURNING id',
      [alpha.companyId, 'Movable', 'Europe/London'],
    );
    alpha.screenId = screen.rows[0]!.id;
    // History belonging to the ORIGINAL company, plus a screenshot marker.
    await query(
      `INSERT INTO proof_of_play (company_id, screen_id, item_name, played_at)
       VALUES ($1, $2, 'alpha-secret.mp4', now() - interval '1 hour')`,
      [alpha.companyId, alpha.screenId],
    );
    await query('UPDATE screens SET screenshot_at = now() WHERE id = $1', [alpha.screenId]);

    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('leaves no play history behind under the old company', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/screens/${alpha.screenId}/move`,
      headers: { authorization: `Bearer ${mspToken}` },
      payload: { companyId: beta.companyId },
    });
    expect(res.statusCode).toBe(200);

    // The leak: rows keyed to the old company_id kept showing in that tenant's
    // reports, and the report's join to screens rendered the NEW tenant's name.
    const left = await query('SELECT count(*)::int AS n FROM proof_of_play WHERE company_id = $1', [
      alpha.companyId,
    ]);
    expect(Number(left.rows[0]!.n)).toBe(0);

    const anyForScreen = await query(
      'SELECT count(*)::int AS n FROM proof_of_play WHERE screen_id = $1',
      [alpha.screenId],
    );
    expect(Number(anyForScreen.rows[0]!.n)).toBe(0);
  });

  it('clears the screenshot so the new company cannot view the old one', async () => {
    const row = await query('SELECT screenshot_at, company_id FROM screens WHERE id = $1', [
      alpha.screenId,
    ]);
    expect(row.rows[0]!.screenshot_at).toBeNull();
    expect(row.rows[0]!.company_id).toBe(beta.companyId);
  });
});

describeDb('dashboard now-playing matches schedule resolution', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, string>[] }>;
  let token = '';
  let companyId = '';
  let screenId = '';

  const screenRow = async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/screens',
      headers: { authorization: `Bearer ${token}` },
    });
    const rows = res.json() as { id: string; playlist_name: string | null }[];
    return rows.find((r) => r.id === screenId);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    const { signUserToken } = await import('../lib/tokens.js');
    query = pool.query as typeof query;

    await migrate();
    await query('DELETE FROM assignments');
    await query('DELETE FROM playlists');
    await query('DELETE FROM screens');
    await query('DELETE FROM users');
    await query('DELETE FROM companies');

    const c = await query('INSERT INTO companies (name) VALUES ($1) RETURNING id', ['SchedCo']);
    companyId = c.rows[0]!.id;
    const user = await query(
      `INSERT INTO users (email, password_hash, display_name, level, role, totp_enabled)
       VALUES ('sched@test.test', 'x', 'MSP', 'msp', 'admin', true) RETURNING id`,
    );
    token = signUserToken(user.rows[0]!.id);
    const screen = await query(
      'INSERT INTO screens (company_id, name, timezone) VALUES ($1, $2, $3) RETURNING id',
      [companyId, 'SchedScreen', 'Europe/London'],
    );
    screenId = screen.rows[0]!.id;

    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const addPlaylist = async (name: string) => {
    const { rows } = await query(
      'INSERT INTO playlists (company_id, name) VALUES ($1, $2) RETURNING id',
      [companyId, name],
    );
    return rows[0]!.id;
  };

  it('ignores an assignment whose date range has passed', async () => {
    const expired = await addPlaylist('Expired');
    await query(
      `INSERT INTO assignments (company_id, screen_id, playlist_id, priority, start_date, end_date)
       VALUES ($1, $2, $3, 0, now()::date - 30, now()::date - 10)`,
      [companyId, screenId, expired],
    );
    // The old query ordered on created_at only, so this expired row displayed as
    // "now playing" while the screen played nothing.
    expect((await screenRow())?.playlist_name).not.toBe('Expired');
  });

  it('prefers the higher-priority assignment, not the newest', async () => {
    const low = await addPlaylist('LowPriority');
    const high = await addPlaylist('HighPriority');
    // High priority created FIRST, so a created_at-only ordering picks the wrong one.
    await query(
      `INSERT INTO assignments (company_id, screen_id, playlist_id, priority) VALUES ($1, $2, $3, 100)`,
      [companyId, screenId, high],
    );
    await query(
      `INSERT INTO assignments (company_id, screen_id, playlist_id, priority) VALUES ($1, $2, $3, 0)`,
      [companyId, screenId, low],
    );
    expect((await screenRow())?.playlist_name).toBe('HighPriority');
  });

  it('ignores an assignment outside its time window', async () => {
    await query('DELETE FROM assignments WHERE company_id = $1', [companyId]);
    const nightly = await addPlaylist('NightOnly');
    // A window that definitely excludes "now" in the screen's timezone: start one
    // hour ahead, end two hours ahead.
    await query(
      `INSERT INTO assignments (company_id, screen_id, playlist_id, priority, days_of_week, start_time, end_time)
       VALUES ($1, $2, $3, 50, ARRAY[0,1,2,3,4,5,6],
               ((now() AT TIME ZONE 'Europe/London') + interval '1 hour')::time,
               ((now() AT TIME ZONE 'Europe/London') + interval '2 hours')::time)`,
      [companyId, screenId, nightly],
    );
    expect((await screenRow())?.playlist_name).not.toBe('NightOnly');
  });

  it('selects an assignment whose window is currently open', async () => {
    await query('DELETE FROM assignments WHERE company_id = $1', [companyId]);
    const now = await addPlaylist('OnNow');
    await query(
      `INSERT INTO assignments (company_id, screen_id, playlist_id, priority, days_of_week, start_time, end_time)
       VALUES ($1, $2, $3, 50, ARRAY[0,1,2,3,4,5,6],
               ((now() AT TIME ZONE 'Europe/London') - interval '1 hour')::time,
               ((now() AT TIME ZONE 'Europe/London') + interval '1 hour')::time)`,
      [companyId, screenId, now],
    );
    expect((await screenRow())?.playlist_name).toBe('OnNow');
  });

  it('honours day-of-week using the screen timezone', async () => {
    await query('DELETE FROM assignments WHERE company_id = $1', [companyId]);
    const wrongDay = await addPlaylist('WrongDay');
    // Every day EXCEPT today in the screen's zone - so it must not be selected.
    await query(
      `INSERT INTO assignments (company_id, screen_id, playlist_id, priority, days_of_week, start_time, end_time)
       SELECT $1, $2, $3, 50,
              array(SELECT d FROM generate_series(0,6) d
                    WHERE d <> extract(dow FROM (now() AT TIME ZONE 'Europe/London'))::int),
              '00:00'::time, '23:59'::time`,
      [companyId, screenId, wrongDay],
    );
    expect((await screenRow())?.playlist_name).not.toBe('WrongDay');
  });
});

describeDb('heartbeat media error reporting', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, string>[] }>;
  let token = '';
  let screenId = '';

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    const { signDeviceToken } = await import('../lib/tokens.js');
    query = pool.query as typeof query;

    await migrate();
    await query('DELETE FROM screens');
    await query('DELETE FROM companies');
    const c = await query('INSERT INTO companies (name) VALUES ($1) RETURNING id', ['HbCo']);
    const jti = crypto.randomUUID();
    const s = await query(
      `INSERT INTO screens (company_id, name, timezone, device_token_jti)
       VALUES ($1, 'HbScreen', 'Europe/London', $2) RETURNING id`,
      [c.rows[0]!.id, jti],
    );
    screenId = s.rows[0]!.id;
    token = signDeviceToken(screenId, jti);

    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const beat = (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/device/heartbeat',
      headers: { authorization: `Bearer ${token}` },
      payload: { appVersion: '1.4.3', storageFreeMb: 1000, ...body },
    });

  it('stores a reported media download failure', async () => {
    const res = await beat({ mediaError: 'clip.mp4: timeout' });
    expect(res.statusCode).toBe(200);
    const row = await query('SELECT media_error FROM screens WHERE id = $1', [screenId]);
    expect(row.rows[0]!.media_error).toBe('clip.mp4: timeout');
  });

  it('clears it once the download succeeds', async () => {
    // Set directly rather than coalesced, so a healthy heartbeat wipes a stale
    // failure - otherwise a fixed screen shows an error forever.
    const res = await beat({ mediaError: null });
    expect(res.statusCode).toBe(200);
    const row = await query('SELECT media_error FROM screens WHERE id = $1', [screenId]);
    expect(row.rows[0]!.media_error).toBeNull();
  });

  it('still records the other telemetry alongside it', async () => {
    await beat({ mediaError: 'x: fail', localIp: '10.1.2.3', ramFreeMb: 256 });
    const row = await query(
      'SELECT media_error, local_ip, ram_free_mb FROM screens WHERE id = $1',
      [screenId],
    );
    expect(row.rows[0]!.media_error).toBe('x: fail');
    expect(row.rows[0]!.local_ip).toBe('10.1.2.3');
    expect(Number(row.rows[0]!.ram_free_mb)).toBe(256);
  });
});

describeDb('config import', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, string>[] }>;
  let token = '';
  let companyId = '';

  const doImport = (payload: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/companies/${companyId}/import`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });

  // groups is required by the import schema, so every fixture supplies it.
  const doc = (playlists: { name: string; items: unknown[] }[]) => ({
    galaxyMediaExport: 1,
    groups: [],
    playlists,
    layouts: [],
    assignments: [],
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    const { signUserToken } = await import('../lib/tokens.js');
    query = pool.query as typeof query;

    await migrate();
    await query('DELETE FROM assignments');
    await query('DELETE FROM playlists');
    await query('DELETE FROM users');
    await query('DELETE FROM companies');

    const c = await query('INSERT INTO companies (name) VALUES ($1) RETURNING id', ['ImportCo']);
    companyId = c.rows[0]!.id;
    const user = await query(
      `INSERT INTO users (email, password_hash, display_name, level, role, totp_enabled)
       VALUES ('imp@test.test', 'x', 'MSP', 'msp', 'admin', true) RETURNING id`,
    );
    token = signUserToken(user.rows[0]!.id);

    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    // Last suite in the file: release the shared pool so vitest can exit.
    const pool = await import('../db/pool.js');
    await pool.pool.end();
  });

  it('suffixes name collisions without compounding them', async () => {
    // Importing the same document repeatedly used to append " (imported)" each
    // time - "Menu (imported) (imported) (imported)" - until the name outgrew
    // what a later export would accept, making the company un-exportable.
    for (let i = 0; i < 4; i++) {
      const res = await doImport(doc([{ name: 'Menu', items: [] }]));
      expect(res.statusCode).toBeLessThan(300);
    }
    const { rows } = await query(
      'SELECT name FROM playlists WHERE company_id = $1 ORDER BY name',
      [companyId],
    );
    const names = rows.map((r) => r.name);
    expect(names).toHaveLength(4);
    // Every name must stay within what the export schema will re-accept.
    for (const name of names) expect(name.length).toBeLessThanOrEqual(200);
    expect(names.some((n) => n.includes('(imported) (imported)'))).toBe(false);
  });

  it('rejects custom layout zones that fall outside the screen', async () => {
    // The import schema had no geometry bounds at all, so a hand-edited export
    // could install zones the create endpoint would refuse.
    const res = await doImport({
      galaxyMediaExport: 1,
      groups: [],
      playlists: [],
      layouts: [
        {
          name: 'OffScreen',
          preset: 'custom',
          zones: { custom: [{ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }] },
        },
      ],
      assignments: [],
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects overlapping custom zones', async () => {
    const res = await doImport({
      galaxyMediaExport: 1,
      groups: [],
      playlists: [],
      layouts: [
        {
          name: 'Overlapping',
          preset: 'custom',
          zones: {
            custom: [
              { x: 0, y: 0, w: 0.6, h: 0.6 },
              { x: 0.3, y: 0.3, w: 0.6, h: 0.6 },
            ],
          },
        },
      ],
      assignments: [],
    });
    expect(res.statusCode).toBe(400);
  });
});
