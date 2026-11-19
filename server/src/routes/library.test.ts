/**
 * Media folders, playlist/layout usage warnings and tenancy for playlists, layouts and
 * assignments. isolation.test.ts only proves tenancy for screens; the content routes
 * (where a recursive folder delete permanently destroys files) had no route tests.
 *
 * Needs Postgres: set TEST_DATABASE_URL (a throwaway database). Skips without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

describeDb('content library routes', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  const alpha = { companyId: '', token: '' };
  const beta = { companyId: '', token: '' };
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const call = (token: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: auth(token), ...(payload ? { payload: payload as object } : {}) });

  const folder = async (companyId: string, name: string, parent: string | null = null) =>
    (await query('INSERT INTO media_folders (company_id, parent_id, name) VALUES ($1, $2, $3) RETURNING id', [companyId, parent, name])).rows[0]!.id as string;
  const media = async (companyId: string, folderId: string | null, name: string) =>
    (
      await query(
        `INSERT INTO media (company_id, folder_id, kind, original_name, mime, size_bytes, sha256)
         VALUES ($1, $2, 'image', $3, 'image/png', 10, 'abc') RETURNING id`,
        [companyId, folderId, name],
      )
    ).rows[0]!.id as string;
  const playlist = async (companyId: string, name: string) =>
    (await query('INSERT INTO playlists (company_id, name) VALUES ($1, $2) RETURNING id', [companyId, name])).rows[0]!.id as string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    const { signUserToken } = await import('../lib/tokens.js');
    query = pool.query as typeof query;
    await migrate();
    for (const t of ['assignments', 'layouts', 'playlists', 'media', 'media_folders', 'screens', 'users', 'companies']) {
      await query(`DELETE FROM ${t}`);
    }
    for (const [name, fx] of [['LibAlpha', alpha], ['LibBeta', beta]] as const) {
      fx.companyId = (await query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name])).rows[0]!.id;
      const user = await query(
        `INSERT INTO users (email, password_hash, display_name, level, role, company_id, totp_enabled)
         VALUES ($1, 'x', $2, 'company', 'admin', $3, true) RETURNING id`,
        [`lib@${name.toLowerCase()}.test`, name, fx.companyId],
      );
      fx.token = signUserToken(user.rows[0]!.id);
    }
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('deleting a media folder', () => {
    it('moves contents up to the parent when not recursive', async () => {
      const top = await folder(alpha.companyId, 'top');
      const mid = await folder(alpha.companyId, 'mid', top);
      const leaf = await folder(alpha.companyId, 'leaf', mid);
      const m = await media(alpha.companyId, mid, 'a.png');

      const res = await call(alpha.token, 'DELETE', `/api/folders/${mid}`);
      expect(res.statusCode).toBe(200);
      expect((await query('SELECT folder_id FROM media WHERE id = $1', [m])).rows[0]!.folder_id).toBe(top);
      expect((await query('SELECT parent_id FROM media_folders WHERE id = $1', [leaf])).rows[0]!.parent_id).toBe(top);
      expect((await query('SELECT 1 FROM media_folders WHERE id = $1', [mid])).rows).toHaveLength(0);
    });

    it('deletes the whole subtree and its media when recursive, and reports the counts', async () => {
      const top = await folder(alpha.companyId, 'doomed');
      const sub = await folder(alpha.companyId, 'doomed-sub', top);
      const m1 = await media(alpha.companyId, top, 'one.png');
      const m2 = await media(alpha.companyId, sub, 'two.png');
      const keep = await media(alpha.companyId, null, 'keep.png');

      const res = await call(alpha.token, 'DELETE', `/api/folders/${top}?recursive=true`);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ foldersDeleted: 2, mediaDeleted: 2 });
      expect((await query('SELECT id FROM media WHERE id = ANY($1::uuid[])', [[m1, m2]])).rows).toHaveLength(0);
      expect((await query('SELECT id FROM media WHERE id = $1', [keep])).rows).toHaveLength(1);
    });

    it("will not delete another company's folder, recursively or not", async () => {
      const f = await folder(alpha.companyId, 'private');
      const m = await media(alpha.companyId, f, 'secret.png');
      expect((await call(beta.token, 'DELETE', `/api/folders/${f}`)).statusCode).toBe(403);
      expect((await call(beta.token, 'DELETE', `/api/folders/${f}?recursive=true`)).statusCode).toBe(403);
      expect((await query('SELECT id FROM media WHERE id = $1', [m])).rows).toHaveLength(1);
    });
  });

  describe('usage warnings before deleting', () => {
    it('counts the schedule slots and layouts that use a playlist', async () => {
      const p = await playlist(alpha.companyId, 'Menu');
      const otherP = await playlist(alpha.companyId, 'Other');
      const screenId = (await query(`INSERT INTO screens (company_id, name) VALUES ($1, 'S') RETURNING id`, [alpha.companyId])).rows[0]!.id;
      await query('INSERT INTO assignments (company_id, playlist_id, screen_id) VALUES ($1, $2, $3), ($1, $2, $3), ($1, $4, $3)', [
        alpha.companyId, p, screenId, otherP,
      ]);
      await query(`INSERT INTO layouts (company_id, name, preset, zones) VALUES ($1, 'L', 'main-side', $2)`, [
        alpha.companyId, JSON.stringify({ main: p, side: otherP }),
      ]);

      const res = await call(alpha.token, 'GET', `/api/playlists/${p}/usage`);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ assignments: 2, layouts: 1 });
      expect(JSON.parse((await call(alpha.token, 'GET', `/api/playlists/${await playlist(alpha.companyId, 'Unused')}/usage`)).body)).toEqual({ assignments: 0, layouts: 0 });
    });

    it('counts the schedule slots that use a layout', async () => {
      const l = (await query(`INSERT INTO layouts (company_id, name, preset, zones) VALUES ($1, 'L2', 'split-2', '{}') RETURNING id`, [alpha.companyId])).rows[0]!.id;
      const screenId = (await query(`INSERT INTO screens (company_id, name) VALUES ($1, 'S2') RETURNING id`, [alpha.companyId])).rows[0]!.id;
      await query('INSERT INTO assignments (company_id, layout_id, screen_id) VALUES ($1, $2, $3)', [alpha.companyId, l, screenId]);
      const res = await call(alpha.token, 'GET', `/api/layouts/${l}/usage`);
      expect(JSON.parse(res.body)).toEqual({ assignments: 1 });
    });

    it('404s for something that does not exist', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      expect((await call(alpha.token, 'GET', `/api/playlists/${missing}/usage`)).statusCode).toBe(404);
      expect((await call(alpha.token, 'GET', `/api/layouts/${missing}/usage`)).statusCode).toBe(404);
    });
  });

  describe('tenancy of playlists, layouts and assignments', () => {
    it("hides another company's playlist usage, and refuses to delete it", async () => {
      const p = await playlist(alpha.companyId, 'Alpha only');
      expect((await call(beta.token, 'GET', `/api/playlists/${p}/usage`)).statusCode).toBe(403);
      expect((await call(beta.token, 'DELETE', `/api/playlists/${p}`)).statusCode).toBe(403);
      expect((await query('SELECT 1 FROM playlists WHERE id = $1', [p])).rows).toHaveLength(1);
    });

    it("hides another company's layout usage, and refuses to delete it", async () => {
      const l = (await query(`INSERT INTO layouts (company_id, name, preset, zones) VALUES ($1, 'AL', 'split-2', '{}') RETURNING id`, [alpha.companyId])).rows[0]!.id;
      expect((await call(beta.token, 'GET', `/api/layouts/${l}/usage`)).statusCode).toBe(403);
      expect((await call(beta.token, 'DELETE', `/api/layouts/${l}`)).statusCode).toBe(403);
    });

    it("refuses to delete another company's assignment", async () => {
      const p = await playlist(alpha.companyId, 'P');
      const screenId = (await query(`INSERT INTO screens (company_id, name) VALUES ($1, 'S3') RETURNING id`, [alpha.companyId])).rows[0]!.id;
      const a = (await query('INSERT INTO assignments (company_id, playlist_id, screen_id) VALUES ($1, $2, $3) RETURNING id', [alpha.companyId, p, screenId])).rows[0]!.id;
      expect((await call(beta.token, 'DELETE', `/api/assignments/${a}`)).statusCode).toBe(403);
      expect((await query('SELECT 1 FROM assignments WHERE id = $1', [a])).rows).toHaveLength(1);
    });

    it("lists only the caller's own playlists", async () => {
      await playlist(beta.companyId, 'Beta list');
      const res = await call(alpha.token, 'GET', `/api/companies/${alpha.companyId}/playlists`);
      const names = (JSON.parse(res.body) as { name: string }[]).map((p) => p.name);
      expect(names).not.toContain('Beta list');
      expect((await call(alpha.token, 'GET', `/api/companies/${beta.companyId}/playlists`)).statusCode).toBe(403);
    });
  });
});
