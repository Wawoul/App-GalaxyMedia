/**
 * Chunked uploads: a big file sent as many small requests (so no single request meets a proxy's
 * body cap). Covers the happy path, resuming after a refused/stale piece, content checks at the
 * end, limits, and who may touch an upload. A 1MB piece size keeps the files small.
 *
 * Needs Postgres: set TEST_DATABASE_URL (a throwaway database). Skips without it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

const MB = 1024 * 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A "PNG" of the given size: valid signature, deterministic filler (the sniff only reads the header). */
const fakePng = (bytes: number) => {
  const b = Buffer.alloc(bytes);
  PNG_SIG.copy(b);
  for (let i = 8; i < bytes; i++) b[i] = (i * 31) & 0xff;
  return b;
};

describeDb('chunked uploads', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  let mediaDir: string;
  const alpha = { companyId: '', token: '' };
  const beta = { companyId: '', token: '' };
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const init = (token: string, companyId: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/companies/${companyId}/media/uploads`, headers: auth(token), payload: body });
  const piece = (token: string, id: string, offset: number, data: Buffer) =>
    app.inject({
      method: 'PUT', url: `/api/media/uploads/${id}?offset=${offset}`, body: data,
      headers: { ...auth(token), 'content-type': 'application/octet-stream' },
    });
  const complete = (token: string, id: string) =>
    app.inject({ method: 'POST', url: `/api/media/uploads/${id}/complete`, headers: auth(token) });
  const status = async (token: string, id: string) =>
    app.inject({ method: 'GET', url: `/api/media/uploads/${id}`, headers: auth(token) });
  const cancel = (token: string, id: string) =>
    app.inject({ method: 'DELETE', url: `/api/media/uploads/${id}`, headers: auth(token) });
  const scratchFiles = () =>
    (existsSync(path.join(mediaDir, alpha.companyId)) ? readdirSync(path.join(mediaDir, alpha.companyId)) : []).filter((f) => f.startsWith('.upload-chunked-'));

  /** Send `data` from `from` onwards in `chunkSize` pieces, the way the browser does. */
  async function sendFrom(token: string, id: string, data: Buffer, from: number, chunkSize: number) {
    for (let off = from; off < data.length; off += chunkSize) {
      const res = await piece(token, id, off, data.subarray(off, off + chunkSize));
      expect(res.statusCode).toBe(200);
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.MIN_FREE_DISK_MB = '1';
    process.env.UPLOAD_CHUNK_MB = '1';
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    const { signUserToken } = await import('../lib/tokens.js');
    const { config } = await import('../config.js');
    mediaDir = config.MEDIA_DIR;
    query = pool.query as typeof query;
    await migrate();
    for (const t of ['designs', 'playlist_items', 'assignments', 'layouts', 'playlists', 'media', 'media_folders', 'screens', 'users', 'companies']) {
      await query(`DELETE FROM ${t}`);
    }
    for (const [name, fx] of [['ChunkAlpha', alpha], ['ChunkBeta', beta]] as const) {
      fx.companyId = (await query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name])).rows[0]!.id;
      const user = await query(
        `INSERT INTO users (email, password_hash, display_name, level, role, company_id, totp_enabled)
         VALUES ($1, 'x', $2, 'company', 'admin', $3, true) RETURNING id`,
        [`chunk@${name.toLowerCase()}.test`, name, fx.companyId],
      );
      fx.token = signUserToken(user.rows[0]!.id);
    }
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('assembles pieces into one stored file with the right checksum', async () => {
    const data = fakePng(2 * MB + 512 * 1024); // 3 pieces at 1MB
    const started = await init(alpha.token, alpha.companyId, { fileName: 'big.png', size: data.length });
    expect(started.statusCode).toBe(201);
    const { uploadId, chunkSize } = started.json();
    expect(chunkSize).toBe(MB);

    await sendFrom(alpha.token, uploadId, data, 0, chunkSize);
    const done = await complete(alpha.token, uploadId);
    expect(done.statusCode).toBe(201);
    const media = done.json();
    expect(media).toMatchObject({ original_name: 'big.png', mime: 'image/png', kind: 'image' });
    expect(Number(media.size_bytes)).toBe(data.length);
    expect(media.sha256).toBe(createHash('sha256').update(data).digest('hex'));

    const { mediaPath } = await import('./media.js');
    expect(readFileSync(mediaPath(alpha.companyId, media.id, 'png')).equals(data)).toBe(true);
    expect(scratchFiles()).toHaveLength(0); // the scratch file became the real file
  });

  it('refuses a piece at the wrong offset, reports where it got to, and carries on from there', async () => {
    const data = fakePng(2 * MB + 100);
    const { uploadId, chunkSize } = (await init(alpha.token, alpha.companyId, { fileName: 'resume.png', size: data.length })).json();
    expect((await piece(alpha.token, uploadId, 0, data.subarray(0, chunkSize))).json()).toEqual({ received: MB });

    // The browser lost the reply and re-sent piece 0: refused, and told where the server really is.
    const again = await piece(alpha.token, uploadId, 0, data.subarray(0, chunkSize));
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'offset_mismatch', received: MB });
    // ...and a piece that skips ahead is refused too.
    expect((await piece(alpha.token, uploadId, 2 * MB, data.subarray(2 * MB))).statusCode).toBe(409);

    const where = (await status(alpha.token, uploadId)).json();
    expect(where).toEqual({ received: MB, size: data.length });

    // Resume from the server's offset and finish.
    await sendFrom(alpha.token, uploadId, data, where.received, chunkSize);
    const done = await complete(alpha.token, uploadId);
    expect(done.statusCode).toBe(201);
    expect(done.json().sha256).toBe(createHash('sha256').update(data).digest('hex'));
  });

  it('will not finish an upload that is missing bytes', async () => {
    const data = fakePng(MB + 10);
    const { uploadId, chunkSize } = (await init(alpha.token, alpha.companyId, { fileName: 'short.png', size: data.length })).json();
    await piece(alpha.token, uploadId, 0, data.subarray(0, chunkSize));
    const res = await complete(alpha.token, uploadId);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'incomplete', received: MB, size: data.length });
    await cancel(alpha.token, uploadId);
  });

  it('checks what the file really is at the end, and leaves nothing behind when it is not media', async () => {
    const before = (await query('SELECT count(*)::int AS n FROM media')).rows[0]!.n;
    const text = Buffer.from('#!/bin/sh\necho not an image\n'.repeat(1000));
    const { uploadId, chunkSize } = (await init(alpha.token, alpha.companyId, { fileName: 'evil.png', size: text.length })).json();
    await sendFrom(alpha.token, uploadId, text, 0, chunkSize);
    const res = await complete(alpha.token, uploadId);
    expect(res.statusCode).toBe(415);
    expect((await query('SELECT count(*)::int AS n FROM media')).rows[0]!.n).toBe(before);
    expect(scratchFiles()).toHaveLength(0);
    // The upload is over; the id is no longer valid.
    expect((await piece(alpha.token, uploadId, 0, text)).statusCode).toBe(404);
  });

  it('refuses a piece larger than the piece size or past the declared size, without keeping any of it', async () => {
    const { uploadId } = (await init(alpha.token, alpha.companyId, { fileName: 'over.png', size: 3 * MB })).json();
    expect((await piece(alpha.token, uploadId, 0, fakePng(MB + 4096))).statusCode).toBe(413);
    expect((await status(alpha.token, uploadId)).json().received).toBe(0);

    const small = (await init(alpha.token, alpha.companyId, { fileName: 'tiny.png', size: 1000 })).json();
    expect((await piece(alpha.token, small.uploadId, 0, fakePng(2000))).statusCode).toBe(413);
    for (const id of [uploadId, small.uploadId]) await cancel(alpha.token, id);
  });

  it('applies the size limit up front', async () => {
    const res = await init(alpha.token, alpha.companyId, { fileName: 'huge.mp4', size: 10 * 1024 * MB });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('too_large');
  });

  it('cancelling removes the scratch file', async () => {
    const { uploadId } = (await init(alpha.token, alpha.companyId, { fileName: 'cancel.png', size: 2 * MB })).json();
    await piece(alpha.token, uploadId, 0, fakePng(MB));
    expect(scratchFiles()).toHaveLength(1);
    expect((await cancel(alpha.token, uploadId)).statusCode).toBe(200);
    expect(scratchFiles()).toHaveLength(0);
  });

  it('keeps an upload private to the person who started it, and to their company', async () => {
    const { uploadId } = (await init(alpha.token, alpha.companyId, { fileName: 'mine.png', size: MB })).json();
    // Another company's admin can neither see, feed, finish nor cancel it.
    expect((await status(beta.token, uploadId)).statusCode).toBe(404);
    expect((await piece(beta.token, uploadId, 0, fakePng(MB))).statusCode).toBe(404);
    expect((await complete(beta.token, uploadId)).statusCode).toBe(404);
    await cancel(beta.token, uploadId);
    expect((await status(alpha.token, uploadId)).statusCode).toBe(200); // still there: beta's cancel did nothing
    // And cannot start one in a company that is not theirs.
    expect((await init(beta.token, alpha.companyId, { fileName: 'x.png', size: MB })).statusCode).toBe(403);
    await cancel(alpha.token, uploadId);
  });

  it('limits how many uploads one company can have in flight', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await init(alpha.token, alpha.companyId, { fileName: `f${i}.png`, size: MB })).json().uploadId);
    expect((await init(alpha.token, alpha.companyId, { fileName: 'fifth.png', size: MB })).statusCode).toBe(429);
    for (const id of ids) await cancel(alpha.token, id);
  });

  it('refuses a folder that belongs to another company', async () => {
    const folder = (await query('INSERT INTO media_folders (company_id, name) VALUES ($1, $2) RETURNING id', [beta.companyId, 'Theirs'])).rows[0]!.id as string;
    const res = await init(alpha.token, alpha.companyId, { fileName: 'f.png', size: MB, folderId: folder });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('folder_not_found');
  });
});
