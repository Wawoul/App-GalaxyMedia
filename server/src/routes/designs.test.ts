/**
 * Slide designer routes: publishing a rendered slide, the revision swap (a save publishes a
 * NEW media row and moves playlist items over - the Android cache would otherwise keep the
 * old file), content/tenancy checks, and templates.
 *
 * Needs Postgres: set TEST_DATABASE_URL (a throwaway database). Skips without it.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (fill = 0) => Buffer.concat([PNG_SIG, Buffer.alloc(512, fill)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(256)]);

const doc = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  background: { color: '#ffffff' },
  objects: [{ id: 'a', type: 'text', text: 'Hello', x: 10, y: 10, width: 400 }],
  ...extra,
});

describeDb('slide designer routes', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  let mediaPath: (companyId: string, mediaId: string, ext: string) => string;
  const alpha = { companyId: '', token: '', playlistId: '' };
  const beta = { companyId: '', token: '' };
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  /** multipart/form-data body: text fields first, the file LAST (the server only sees fields before it). */
  function form(fields: Record<string, string>, file?: Buffer, filename = 'slide.png') {
    const boundary = '----gmdesign';
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    if (file) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
      parts.push(file, Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  const send = (token: string, method: 'POST' | 'PUT', url: string, fields: Record<string, string>, file?: Buffer) => {
    const f = form(fields, file);
    return app.inject({ method, url, body: f.body, headers: { ...auth(token), 'content-type': f.contentType } });
  };
  const create = (fields: Record<string, string> = {}, file: Buffer | undefined = png(1), token = alpha.token, companyId = alpha.companyId) =>
    send(token, 'POST', `/api/companies/${companyId}/designs`, { name: 'Welcome', width: '1920', height: '1080', doc: JSON.stringify(doc()), ...fields }, file);

  const mediaRow = async (id: string) => (await query('SELECT id, mime, original_name FROM media WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.MIN_FREE_DISK_MB = '1';
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    const { signUserToken } = await import('../lib/tokens.js');
    ({ mediaPath } = await import('./media.js'));
    query = pool.query as typeof query;
    await migrate();
    for (const t of ['designs', 'playlist_items', 'assignments', 'layouts', 'playlists', 'media', 'media_folders', 'screens', 'users', 'companies']) {
      await query(`DELETE FROM ${t}`);
    }
    for (const [name, fx] of [['DesAlpha', alpha], ['DesBeta', beta]] as const) {
      fx.companyId = (await query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name])).rows[0]!.id;
      const user = await query(
        `INSERT INTO users (email, password_hash, display_name, level, role, company_id, totp_enabled)
         VALUES ($1, 'x', $2, 'company', 'admin', $3, true) RETURNING id`,
        [`des@${name.toLowerCase()}.test`, name, fx.companyId],
      );
      fx.token = signUserToken(user.rows[0]!.id);
    }
    alpha.playlistId = (await query('INSERT INTO playlists (company_id, name) VALUES ($1, $2) RETURNING id', [alpha.companyId, 'Lobby'])).rows[0]!.id;
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('publishing a slide', () => {
    it('stores the rendered PNG as media, keeps the document, and appends to the playlist', async () => {
      const res = await create({ playlistId: alpha.playlistId, durationMs: '15000' });
      expect(res.statusCode).toBe(201);
      const design = res.json();
      expect(design).toMatchObject({ name: 'Welcome', width: 1920, height: 1080, is_template: false, version: 1 });

      const media = await mediaRow(design.media_id);
      expect(media).toMatchObject({ mime: 'image/png', original_name: 'Welcome.png' });
      expect(existsSync(mediaPath(alpha.companyId, design.media_id, 'png'))).toBe(true);

      const items = (await query('SELECT media_id, duration_ms, position FROM playlist_items WHERE playlist_id = $1', [alpha.playlistId])).rows;
      expect(items).toEqual([{ media_id: design.media_id, duration_ms: 15000, position: 0 }]);

      const full = await app.inject({ method: 'GET', url: `/api/designs/${design.id}`, headers: auth(alpha.token) });
      expect(full.json().document.objects[0].text).toBe('Hello');
    });

    it('accepts portrait but rejects any other size', async () => {
      expect((await create({ width: '1080', height: '1920' })).statusCode).toBe(201);
      expect((await create({ width: '1280', height: '720' })).statusCode).toBe(400);
    });

    it('refuses a file that is not a PNG and leaves no media behind', async () => {
      const before = (await query('SELECT count(*)::int AS n FROM media')).rows[0]!.n;
      const res = await create({}, jpeg());
      expect(res.statusCode).toBe(415);
      expect((await query('SELECT count(*)::int AS n FROM media')).rows[0]!.n).toBe(before);
    });

    it('refuses a document that points at another company’s image', async () => {
      const other = (await query(
        `INSERT INTO media (company_id, kind, original_name, mime, size_bytes, sha256) VALUES ($1, 'image', 'x.png', 'image/png', 1, 'abc') RETURNING id`,
        [beta.companyId],
      )).rows[0]!.id as string;
      const bad = doc({ objects: [{ id: 'i', type: 'image', mediaId: other, x: 0, y: 0, width: 10, height: 10 }] });
      const res = await create({ doc: JSON.stringify(bad) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('media_not_found');
    });

    it('rejects a malformed document', async () => {
      const res = await create({ doc: '{"v":9}' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('saving changes (revision swap)', () => {
    it('publishes a new media row, moves playlist items to it and retires the old file', async () => {
      const playlistId = (await query('INSERT INTO playlists (company_id, name) VALUES ($1, $2) RETURNING id', [alpha.companyId, 'Swap'])).rows[0]!.id as string;
      const first = (await create({ playlistId, name: 'Menu' }, png(2))).json();
      const oldPath = mediaPath(alpha.companyId, first.media_id, 'png');
      expect(existsSync(oldPath)).toBe(true);

      const res = await send(alpha.token, 'PUT', `/api/designs/${first.id}`, { name: 'Menu v2', baseVersion: '1', doc: JSON.stringify(doc({ background: { color: '#000000' } })) }, png(3));
      expect(res.statusCode).toBe(200);
      const next = res.json();
      expect(next.media_id).not.toBe(first.media_id);
      expect(next).toMatchObject({ name: 'Menu v2', version: 2 });

      // Same design, same playlist slot - now pointing at the new file.
      const items = (await query('SELECT media_id FROM playlist_items WHERE playlist_id = $1', [playlistId])).rows;
      expect(items).toEqual([{ media_id: next.media_id }]);
      expect(await mediaRow(first.media_id)).toBeUndefined();
      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(mediaPath(alpha.companyId, next.media_id, 'png'))).toBe(true);
      // The design survived the old media row being deleted (it cascades to designs).
      const full = (await app.inject({ method: 'GET', url: `/api/designs/${first.id}`, headers: auth(alpha.token) })).json();
      expect(full.document.background.color).toBe('#000000');
    });

    it('leaves the slide untouched when the replacement is not a PNG', async () => {
      const made = (await create({ name: 'Keep' })).json();
      const res = await send(alpha.token, 'PUT', `/api/designs/${made.id}`, { name: 'Keep', baseVersion: '1', doc: JSON.stringify(doc()) }, jpeg());
      expect(res.statusCode).toBe(415);
      const row = (await query('SELECT media_id, version FROM designs WHERE id = $1', [made.id])).rows[0];
      expect(row).toEqual({ media_id: made.media_id, version: 1 });
      expect(await mediaRow(made.media_id)).toBeDefined();
    });
  });

  describe('concurrent edits and size', () => {
    it('refuses a save based on an out-of-date version, and leaves no orphan behind', async () => {
      const made = (await create({ name: 'Shared' })).json();
      const ok = await send(alpha.token, 'PUT', `/api/designs/${made.id}`, { name: 'Shared', baseVersion: '1', doc: JSON.stringify(doc()) }, png(6));
      expect(ok.statusCode).toBe(200);
      const mediaBefore = (await query('SELECT count(*)::int AS n FROM media')).rows[0]!.n;

      // A second editor still on version 1 tries to save.
      const stale = await send(alpha.token, 'PUT', `/api/designs/${made.id}`, { name: 'Stale', baseVersion: '1', doc: JSON.stringify(doc()) }, png(7));
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe('conflict');
      expect((await query('SELECT count(*)::int AS n FROM media')).rows[0]!.n).toBe(mediaBefore);
      expect((await query('SELECT name, version FROM designs WHERE id = $1', [made.id])).rows[0]).toEqual({ name: 'Shared', version: 2 });
    });

    it('lets exactly one of two simultaneous saves win, without leaking a file', async () => {
      const playlistId = (await query('INSERT INTO playlists (company_id, name) VALUES ($1, $2) RETURNING id', [alpha.companyId, 'Race'])).rows[0]!.id as string;
      const made = (await create({ name: 'Race', playlistId })).json();
      const before = (await query('SELECT count(*)::int AS n FROM media')).rows[0]!.n;
      const put = (fill: number) => send(alpha.token, 'PUT', `/api/designs/${made.id}`, { name: `R${fill}`, baseVersion: '1', doc: JSON.stringify(doc()) }, png(fill));
      const results = await Promise.all([put(11), put(12)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      // One swap happened: still exactly one media row for this slide, and the playlist points at it.
      expect((await query('SELECT count(*)::int AS n FROM media')).rows[0]!.n).toBe(before);
      const design = (await query('SELECT media_id FROM designs WHERE id = $1', [made.id])).rows[0]!;
      const items = (await query('SELECT media_id FROM playlist_items WHERE playlist_id = $1', [playlistId])).rows;
      expect(items).toEqual([{ media_id: design.media_id }]);
    });

    it('lets the editor overwrite deliberately with force', async () => {
      const made = (await create({ name: 'Force' })).json();
      await send(alpha.token, 'PUT', `/api/designs/${made.id}`, { name: 'Force', baseVersion: '1', doc: JSON.stringify(doc()) }, png(6));
      const res = await send(alpha.token, 'PUT', `/api/designs/${made.id}`, { name: 'Mine', baseVersion: '1', force: '1', doc: JSON.stringify(doc()) }, png(8));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'Mine', version: 3 });
    });

    it('requires a base version unless forced', async () => {
      const made = (await create({ name: 'NoBase' })).json();
      const res = await send(alpha.token, 'PUT', `/api/designs/${made.id}`, { name: 'NoBase', doc: JSON.stringify(doc()) }, png(6));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('base_version_required');
    });

    it('stores a new orientation in the columns and in the document', async () => {
      const made = (await create({ name: 'Turn' })).json();
      const res = await send(alpha.token, 'PUT', `/api/designs/${made.id}`, { name: 'Turn', baseVersion: '1', width: '1080', height: '1920', doc: JSON.stringify(doc()) }, png(6));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ width: 1080, height: 1920 });
      const full = (await app.inject({ method: 'GET', url: `/api/designs/${made.id}`, headers: auth(alpha.token) })).json();
      expect(full.document.size).toEqual({ width: 1080, height: 1920 });
    });

    it('rejects a size that is not 1920x1080 or 1080x1920 on save', async () => {
      const made = (await create({ name: 'Odd' })).json();
      const res = await send(alpha.token, 'PUT', `/api/designs/${made.id}`, { name: 'Odd', baseVersion: '1', width: '800', height: '600', doc: JSON.stringify(doc()) }, png(6));
      expect(res.statusCode).toBe(400);
    });
  });

  describe('library interplay', () => {
    it('renaming the file in the library renames the design too', async () => {
      const made = (await create({ name: 'Old name' })).json();
      const res = await app.inject({ method: 'PATCH', url: `/api/media/${made.media_id}`, headers: auth(alpha.token), payload: { name: 'New name.png' } });
      expect(res.statusCode).toBe(200);
      expect((await query('SELECT name FROM designs WHERE id = $1', [made.id])).rows[0]!.name).toBe('New name');
    });

    it('duplicates a slide with its own file and appends it to a playlist', async () => {
      const playlistId = (await query('INSERT INTO playlists (company_id, name) VALUES ($1, $2) RETURNING id', [alpha.companyId, 'Dup'])).rows[0]!.id as string;
      const made = (await create({ name: 'Original', playlistId })).json();
      const res = await app.inject({ method: 'POST', url: `/api/designs/${made.id}/duplicate`, headers: auth(alpha.token), payload: { playlistId } });
      expect(res.statusCode).toBe(201);
      const copy = res.json();
      expect(copy.name).toBe('Original (copy)');
      expect(copy.media_id).not.toBe(made.media_id);
      expect(existsSync(mediaPath(alpha.companyId, copy.media_id, 'png'))).toBe(true);
      const items = (await query('SELECT media_id FROM playlist_items WHERE playlist_id = $1 ORDER BY position', [playlistId])).rows.map((r) => r.media_id);
      expect(items).toEqual([made.media_id, copy.media_id]);
      // Independent: deleting the copy leaves the original in place.
      await app.inject({ method: 'DELETE', url: `/api/designs/${copy.id}`, headers: auth(alpha.token) });
      expect(await mediaRow(made.media_id)).toBeDefined();
    });

    it('cannot duplicate another company’s slide', async () => {
      const made = (await create({ name: 'Mine' })).json();
      const res = await app.inject({ method: 'POST', url: `/api/designs/${made.id}/duplicate`, headers: auth(beta.token), payload: {} });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a template preview that is not an inline JPEG', async () => {
      const res = await app.inject({
        method: 'POST', url: `/api/companies/${alpha.companyId}/design-templates`, headers: auth(alpha.token),
        payload: { name: 'Sneaky', width: 1920, height: 1080, document: doc({ preview: 'https://tracker.example/pixel.gif' }) },
      });
      expect(res.statusCode).toBe(400);
    });

    it('lists template previews without loading every document', async () => {
      const made = await app.inject({
        method: 'POST', url: `/api/companies/${alpha.companyId}/design-templates`, headers: auth(alpha.token),
        payload: { name: 'WithPic', width: 1920, height: 1080, document: doc({ preview: 'data:image/jpeg;base64,AAAA' }) },
      });
      const list = (await app.inject({ method: 'GET', url: `/api/companies/${alpha.companyId}/designs?templates=true`, headers: auth(alpha.token) })).json();
      expect(list.find((t: { id: string }) => t.id === made.json().id).preview).toBe('data:image/jpeg;base64,AAAA');
    });
  });

  describe('live slides (widgets and animation)', () => {
    const clock = { id: 'w1', type: 'widget', kind: 'clock', x: 10, y: 10, width: 400 };
    const liveDoc = () => doc({ objects: [clock] });
    const fadeDoc = () => doc({ objects: [{ id: 't', type: 'text', text: 'Hi', x: 0, y: 0, width: 200, anim: { enter: 'fade', durationMs: 600 } }] });
    const items = async (playlistId: string) => (await query('SELECT media_id, url, duration_ms FROM playlist_items WHERE playlist_id = $1 ORDER BY position', [playlistId])).rows;
    const newPlaylist = async (name: string) => (await query('INSERT INTO playlists (company_id, name) VALUES ($1, $2) RETURNING id', [alpha.companyId, name])).rows[0]!.id as string;
    let liveUrl: (id: string) => string;
    let liveSig: (id: string) => string;
    beforeAll(async () => { ({ liveUrl, liveSig } = await import('../lib/liveSlides.js')); });

    it('plays a slide with a widget as a web page, and still keeps its picture in the library', async () => {
      const playlistId = await newPlaylist('LiveA');
      const res = await create({ name: 'Clock', playlistId, doc: JSON.stringify(liveDoc()) });
      expect(res.statusCode).toBe(201);
      const d = res.json();
      expect(d).toMatchObject({ live: true, live_url: liveUrl(d.id) });
      expect(await items(playlistId)).toEqual([{ media_id: null, url: liveUrl(d.id), duration_ms: null }]);
      expect(await mediaRow(d.media_id)).toBeDefined();
    });

    it('treats an entrance animation on any object as live too, and plain slides as still', async () => {
      const a = (await create({ name: 'Fade', doc: JSON.stringify(fadeDoc()) })).json();
      expect(a.live).toBe(true);
      const none = doc({ objects: [{ id: 't', type: 'text', text: 'Hi', x: 0, y: 0, width: 200, anim: { enter: 'none', loop: 'none' } }] });
      expect((await create({ name: 'Still', doc: JSON.stringify(none) })).json().live).toBe(false);
    });

    it('turns playlist entries into the page link when a still slide gains a widget, and back when it loses it', async () => {
      const playlistId = await newPlaylist('Flip');
      const made = (await create({ name: 'Flip', playlistId, durationMs: '12000' })).json();
      expect(made.live).toBe(false);
      expect((await items(playlistId))[0]).toMatchObject({ media_id: made.media_id, url: null, duration_ms: 12000 });

      // Gains a widget -> entry becomes the live page, duration kept.
      const up = await send(alpha.token, 'PUT', `/api/designs/${made.id}`, { name: 'Flip', baseVersion: '1', doc: JSON.stringify(liveDoc()) }, png(21));
      expect(up.json()).toMatchObject({ live: true, version: 2 });
      expect(await items(playlistId)).toEqual([{ media_id: null, url: liveUrl(made.id), duration_ms: 12000 }]);

      // Saving it live again leaves the entry alone.
      const again = await send(alpha.token, 'PUT', `/api/designs/${made.id}`, { name: 'Flip', baseVersion: '2', doc: JSON.stringify(liveDoc()) }, png(22));
      expect(again.statusCode).toBe(200);
      expect(await items(playlistId)).toEqual([{ media_id: null, url: liveUrl(made.id), duration_ms: 12000 }]);

      // Loses it -> entry goes back to the (new) picture.
      const down = await send(alpha.token, 'PUT', `/api/designs/${made.id}`, { name: 'Flip', baseVersion: '3', doc: JSON.stringify(doc()) }, png(23));
      const next = down.json();
      expect(next.live).toBe(false);
      expect(await items(playlistId)).toEqual([{ media_id: next.media_id, url: null, duration_ms: 12000 }]);
    });

    it('removes the playlist entries however the slide is deleted', async () => {
      const p1 = await newPlaylist('Gone1');
      const a = (await create({ name: 'A', playlistId: p1, doc: JSON.stringify(liveDoc()) })).json();
      await app.inject({ method: 'DELETE', url: `/api/designs/${a.id}`, headers: auth(alpha.token) });
      expect(await items(p1)).toHaveLength(0);

      // Deleting the picture in the library takes the slide (and so its entries) with it.
      const p2 = await newPlaylist('Gone2');
      const b = (await create({ name: 'B', playlistId: p2, doc: JSON.stringify(liveDoc()) })).json();
      const del = await app.inject({ method: 'DELETE', url: `/api/media/${b.media_id}`, headers: auth(alpha.token) });
      expect(del.statusCode).toBe(200);
      expect(await items(p2)).toHaveLength(0);
    });

    it('copies a live slide with its own link', async () => {
      const playlistId = await newPlaylist('Dup');
      const made = (await create({ name: 'Orig', playlistId, doc: JSON.stringify(liveDoc()) })).json();
      const copy = (await app.inject({ method: 'POST', url: `/api/designs/${made.id}/duplicate`, headers: auth(alpha.token), payload: { playlistId } })).json();
      expect(copy.live).toBe(true);
      expect((await items(playlistId)).map((i) => i.url)).toEqual([liveUrl(made.id), liveUrl(copy.id)]);
    });

    it('lets the playlist editor keep and re-save the live link', async () => {
      const playlistId = await newPlaylist('Resave');
      const made = (await create({ name: 'Keep', playlistId, doc: JSON.stringify(liveDoc()) })).json();
      const res = await app.inject({
        method: 'PUT', url: `/api/playlists/${playlistId}/items`, headers: auth(alpha.token),
        payload: { items: [{ url: liveUrl(made.id), durationMs: 15000, enabled: true }] },
      });
      expect(res.statusCode).toBe(200);
      // ...but not an arbitrary page on our own host.
      const bad = await app.inject({
        method: 'PUT', url: `/api/playlists/${playlistId}/items`, headers: auth(alpha.token),
        payload: { items: [{ url: `${liveUrl(made.id).split('/live.html')[0]}/`, durationMs: 15000, enabled: true }] },
      });
      expect(bad.statusCode).toBe(400);
    });

    describe('the page data (/api/live)', () => {
      it('serves one slide to whoever holds its signed link - without logging in - and nothing to anyone else', async () => {
        const made = (await create({ name: 'Public', doc: JSON.stringify(liveDoc()) })).json();
        const ok = await app.inject({ method: 'GET', url: `/api/live/${made.id}?s=${liveSig(made.id)}` });
        expect(ok.statusCode).toBe(200);
        expect(ok.headers['access-control-allow-origin']).toBe('*');
        expect(ok.json()).toMatchObject({ name: 'Public', width: 1920, height: 1080, version: 1 });
        expect(ok.json().document.objects[0]).toMatchObject({ type: 'widget', kind: 'clock' });

        // Wrong signature, a signature for a different slide, and an unknown slide all look the same.
        const other = (await create({ name: 'Other', doc: JSON.stringify(liveDoc()) })).json();
        for (const url of [
          `/api/live/${made.id}?s=nope`,
          `/api/live/${made.id}?s=${liveSig(other.id)}`,
          `/api/live/00000000-0000-4000-8000-000000000000?s=${liveSig('00000000-0000-4000-8000-000000000000')}`,
        ]) {
          const res = await app.inject({ method: 'GET', url });
          expect(res.statusCode, url).toBe(404);
        }
        expect((await app.inject({ method: 'GET', url: `/api/live/${made.id}` })).statusCode).toBe(400);
      });

      it('gives picture links only for the slide’s own company, each signed', async () => {
        const mine = (await query(
          `INSERT INTO media (company_id, kind, original_name, mime, size_bytes, sha256) VALUES ($1, 'image', 'logo.png', 'image/png', 1, 'abc') RETURNING id`,
          [alpha.companyId],
        )).rows[0]!.id as string;
        const withPic = doc({ background: { color: '#fff', mediaId: mine }, objects: [clock, { id: 'i', type: 'image', mediaId: mine, x: 0, y: 0, width: 10, height: 10 }] });
        const made = (await create({ name: 'Pic', doc: JSON.stringify(withPic) })).json();
        const res = (await app.inject({ method: 'GET', url: `/api/live/${made.id}?s=${liveSig(made.id)}` })).json();
        expect(Object.keys(res.media)).toEqual([mine]);
        const { verifyDownload } = await import('../lib/crypto.js');
        const token = new URL(res.media[mine], 'http://x').searchParams.get('token')!;
        expect(verifyDownload(mine, token)).toBe(true);
        expect(verifyDownload('some-other-file', token)).toBe(false);
      });

      it('does not serve templates', async () => {
        const tpl = (await app.inject({
          method: 'POST', url: `/api/companies/${alpha.companyId}/design-templates`, headers: auth(alpha.token),
          payload: { name: 'T', width: 1920, height: 1080, document: liveDoc() },
        })).json();
        const res = await app.inject({ method: 'GET', url: `/api/live/${tpl.id}?s=${liveSig(tpl.id)}` });
        expect(res.statusCode).toBe(404);
      });
    });
  });

  describe('deleting', () => {
    it('removes the slide, its image file and its playlist entry', async () => {
      const playlistId = (await query('INSERT INTO playlists (company_id, name) VALUES ($1, $2) RETURNING id', [alpha.companyId, 'Del'])).rows[0]!.id as string;
      const made = (await create({ playlistId, name: 'Bye' })).json();
      const res = await app.inject({ method: 'DELETE', url: `/api/designs/${made.id}`, headers: auth(alpha.token) });
      expect(res.statusCode).toBe(200);
      expect((await query('SELECT 1 FROM designs WHERE id = $1', [made.id])).rows).toHaveLength(0);
      expect((await query('SELECT 1 FROM playlist_items WHERE playlist_id = $1', [playlistId])).rows).toHaveLength(0);
      expect(existsSync(mediaPath(alpha.companyId, made.media_id, 'png'))).toBe(false);
    });
  });

  describe('tenancy', () => {
    it('hides, blocks edits to, and blocks deleting another company’s slide', async () => {
      const made = (await create({ name: 'Private' })).json();
      const get = await app.inject({ method: 'GET', url: `/api/designs/${made.id}`, headers: auth(beta.token) });
      expect(get.statusCode).toBe(403);
      const put = await send(beta.token, 'PUT', `/api/designs/${made.id}`, { name: 'Hijack', baseVersion: '1', doc: JSON.stringify(doc()) }, png(9));
      expect(put.statusCode).toBe(403);
      const del = await app.inject({ method: 'DELETE', url: `/api/designs/${made.id}`, headers: auth(beta.token) });
      expect(del.statusCode).toBe(403);
      const list = await app.inject({ method: 'GET', url: `/api/companies/${alpha.companyId}/designs`, headers: auth(beta.token) });
      expect(list.statusCode).toBe(403);
      expect((await query('SELECT name FROM designs WHERE id = $1', [made.id])).rows[0]!.name).toBe('Private');
    });

    it('will not publish into another company’s playlist', async () => {
      const res = await create({ playlistId: alpha.playlistId }, png(4), beta.token, beta.companyId);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('playlist_not_found');
    });
  });

  describe('templates', () => {
    it('are saved without an image, listed separately, and cannot be re-published', async () => {
      const res = await app.inject({
        method: 'POST', url: `/api/companies/${alpha.companyId}/design-templates`, headers: auth(alpha.token),
        payload: { name: 'Sale', width: 1920, height: 1080, document: doc({ preview: 'data:image/jpeg;base64,AAAA' }) },
      });
      expect(res.statusCode).toBe(201);
      const tpl = res.json();
      expect(tpl).toMatchObject({ is_template: true, media_id: null });

      const templates = (await app.inject({ method: 'GET', url: `/api/companies/${alpha.companyId}/designs?templates=true`, headers: auth(alpha.token) })).json();
      expect(templates.map((t: { id: string }) => t.id)).toContain(tpl.id);
      const slides = (await app.inject({ method: 'GET', url: `/api/companies/${alpha.companyId}/designs`, headers: auth(alpha.token) })).json();
      expect(slides.map((t: { id: string }) => t.id)).not.toContain(tpl.id);

      const full = (await app.inject({ method: 'GET', url: `/api/designs/${tpl.id}`, headers: auth(alpha.token) })).json();
      expect(full.document.preview).toBe('data:image/jpeg;base64,AAAA');

      const put = await send(alpha.token, 'PUT', `/api/designs/${tpl.id}`, { name: 'x', baseVersion: '1', doc: JSON.stringify(doc()) }, png(5));
      expect(put.statusCode).toBe(400);
      const del = await app.inject({ method: 'DELETE', url: `/api/designs/${tpl.id}`, headers: auth(alpha.token) });
      expect(del.statusCode).toBe(200);
      expect((await query('SELECT 1 FROM designs WHERE id = $1', [tpl.id])).rows).toHaveLength(0);
    });
  });
});
