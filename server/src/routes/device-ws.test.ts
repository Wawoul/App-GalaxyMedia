/**
 * The device WebSocket: how a TV proves who it is.
 *
 * The 5-year device token used to travel in the WebSocket URL, which ends up in
 * nginx access logs and the app's own request log. A TV now trades its token
 * (sent in a header, which is not logged) for a one-minute ticket and connects
 * with that. The legacy ?token= form still works so TVs on older builds keep
 * running until they are updated.
 *
 * Needs Postgres: set TEST_DATABASE_URL (a throwaway database). Skips without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

describeDb('device websocket', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  let notifyScreen: (id: string, msg: { type: 'sync' }) => boolean;
  let signDeviceToken: (screenId: string, jti: string) => string;
  const screen = { id: '', jti: '', token: '' };

  const closeCode = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  const firstMessage = (ws: WebSocket) => new Promise<string>((resolve) => ws.once('message', (m) => resolve(String(m))));
  /** Waits until the server has registered the socket, then pushes to it. */
  async function pushWhenRegistered(id: string) {
    for (let i = 0; i < 40; i++) {
      if (notifyScreen(id, { type: 'sync' })) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    ({ notifyScreen } = (await import('../ws.js')) as unknown as { notifyScreen: typeof notifyScreen });
    ({ signDeviceToken } = await import('../lib/tokens.js'));
    query = pool.query as typeof query;

    await migrate();
    await query('DELETE FROM screens');
    await query('DELETE FROM companies');
    const company = (await query(`INSERT INTO companies (name) VALUES ('WsCo') RETURNING id`)).rows[0]!.id;
    screen.jti = '11111111-2222-4333-8444-555555555555';
    screen.id = (
      await query(`INSERT INTO screens (company_id, name, device_token_jti, paired_at) VALUES ($1, 'Lobby', $2, now()) RETURNING id`, [company, screen.jti])
    ).rows[0]!.id;
    screen.token = signDeviceToken(screen.id, screen.jti);

    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const mintTicket = async (token = screen.token) => {
    const res = await app.inject({ method: 'POST', url: '/api/device/ws-ticket', headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') as { ticket?: string; expiresInS?: number } };
  };

  it('hands a paired screen a short-lived ticket, and nobody else', async () => {
    const ok = await mintTicket();
    expect(ok.status).toBe(200);
    expect(ok.body.ticket).toBeTruthy();
    expect(ok.body.expiresInS).toBeLessThanOrEqual(120);
    expect((await app.inject({ method: 'POST', url: '/api/device/ws-ticket' })).statusCode).toBe(401);
    expect((await mintTicket('not-a-token')).status).toBe(401);
  });

  it('accepts a ticket and delivers pushes to that screen', async () => {
    const { body } = await mintTicket();
    const ws = await app.injectWS(`/api/device/ws?ticket=${encodeURIComponent(body.ticket!)}`);
    const message = firstMessage(ws);
    expect(await pushWhenRegistered(screen.id)).toBe(true);
    expect(JSON.parse(await message)).toEqual({ type: 'sync' });
    ws.close();
  });

  it('still accepts the legacy token so older players keep working', async () => {
    const ws = await app.injectWS(`/api/device/ws?token=${encodeURIComponent(screen.token)}`);
    const message = firstMessage(ws);
    expect(await pushWhenRegistered(screen.id)).toBe(true);
    expect(JSON.parse(await message)).toEqual({ type: 'sync' });
    ws.close();
  });

  it('refuses forged tickets, garbage, and a missing credential', async () => {
    for (const query of ['ticket=garbage', `ticket=${screen.id}.9999999999.forged`, 'token=nope', '']) {
      const ws = await app.injectWS(`/api/device/ws?${query}`);
      expect(await closeCode(ws), query).toBe(4001);
    }
  });

  it('refuses a ticket once the screen has been unpaired', async () => {
    const { body } = await mintTicket();
    await query('UPDATE screens SET device_token_jti = NULL WHERE id = $1', [screen.id]);
    try {
      const ws = await app.injectWS(`/api/device/ws?ticket=${encodeURIComponent(body.ticket!)}`);
      expect(await closeCode(ws)).toBe(4001);
    } finally {
      await query('UPDATE screens SET device_token_jti = $2 WHERE id = $1', [screen.id, screen.jti]);
    }
  });
});
