/**
 * Data lifecycle: files must not outlive the rows that own them, and one company
 * must not be able to fill the disk everyone shares.
 *
 * Deleting a company cascaded away every row but left its media folder on disk for
 * ever (a deleted customer's files, and the disk space), and deleting a screen left
 * its last screenshot behind.
 *
 * Needs Postgres: set TEST_DATABASE_URL (a throwaway database). Skips without it.
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

const exists = (p: string) => stat(p).then(() => true, () => false);

describeDb('files follow their rows', () => {
  let app: FastifyInstance;
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  let mediaDir = '';
  let adminToken = '';
  let signUserToken: (id: string) => string;

  const headers = () => ({ authorization: `Bearer ${adminToken}` });
  const newCompany = async (name: string) => (await query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name])).rows[0]!.id as string;

  /** A minimal valid upload: a multipart body whose file starts with JPEG magic bytes. */
  function upload(companyId: string, size = 2048) {
    const boundary = '----gmtest';
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(size)]);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pic.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      jpeg,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST', url: `/api/companies/${companyId}/media`, body,
      headers: { ...headers(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.COMPANY_QUOTA_MB = '1'; // tiny, so the test can reach it
    process.env.MIN_FREE_DISK_MB = '1'; // don't let this machine's free space decide the test
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    const { buildServer } = await import('../index.js');
    const { config } = await import('../config.js');
    ({ signUserToken } = await import('../lib/tokens.js'));
    query = pool.query as typeof query;
    mediaDir = config.MEDIA_DIR;

    await migrate();
    await query('DELETE FROM media');
    await query('DELETE FROM screens');
    await query('DELETE FROM users');
    await query('DELETE FROM companies');
    const admin = await query(
      `INSERT INTO users (email, password_hash, display_name, level, role, totp_enabled)
       VALUES ('cleanup-admin@test.test', 'x', 'Admin', 'msp', 'admin', true) RETURNING id`,
    );
    adminToken = signUserToken(admin.rows[0]!.id);
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("deleting a company removes its media folder - and only that company's", async () => {
    const doomed = await newCompany('Doomed');
    const survivor = await newCompany('Survivor');
    for (const id of [doomed, survivor]) {
      await mkdir(path.join(mediaDir, id), { recursive: true });
      await writeFile(path.join(mediaDir, id, 'file.jpg'), 'x');
    }
    const res = await app.inject({ method: 'DELETE', url: `/api/companies/${doomed}`, headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(await exists(path.join(mediaDir, doomed))).toBe(false);
    expect(await exists(path.join(mediaDir, survivor, 'file.jpg'))).toBe(true);
  });

  it("deleting a company also removes its screens' screenshots", async () => {
    const company = await newCompany('Shots');
    const screen = (await query(`INSERT INTO screens (company_id, name) VALUES ($1, 'S') RETURNING id`, [company])).rows[0]!.id as string;
    await mkdir(path.join(mediaDir, 'screenshots'), { recursive: true });
    const shot = path.join(mediaDir, 'screenshots', `${screen}.jpg`);
    await writeFile(shot, 'jpeg');
    await app.inject({ method: 'DELETE', url: `/api/companies/${company}`, headers: headers() });
    expect(await exists(shot)).toBe(false);
  });

  it("deleting a screen removes that screen's screenshot", async () => {
    const company = await newCompany('ShotCo');
    const screen = (await query(`INSERT INTO screens (company_id, name) VALUES ($1, 'S') RETURNING id`, [company])).rows[0]!.id as string;
    await mkdir(path.join(mediaDir, 'screenshots'), { recursive: true });
    const shot = path.join(mediaDir, 'screenshots', `${screen}.jpg`);
    await writeFile(shot, 'jpeg');
    expect((await app.inject({ method: 'DELETE', url: `/api/screens/${screen}`, headers: headers() })).statusCode).toBe(200);
    expect(await exists(shot)).toBe(false);
  });

  describe('storage quota (1 MB in this test)', () => {
    it('lets a company upload while it is under quota', async () => {
      const company = await newCompany('UnderQuota');
      const res = await upload(company);
      expect(res.statusCode).toBe(201);
    });

    it('refuses an upload once the company is at its quota, and leaves nothing behind', async () => {
      const company = await newCompany('OverQuota');
      await query(
        `INSERT INTO media (company_id, kind, original_name, mime, size_bytes, sha256) VALUES ($1, 'image', 'big.jpg', 'image/jpeg', $2, 'abc')`,
        [company, 1024 * 1024],
      );
      const res = await upload(company);
      expect(res.statusCode).toBe(413);
      expect(JSON.parse(res.body).error).toBe('quota_exceeded');
      const dir = path.join(mediaDir, company);
      const left = (await exists(dir)) ? await readdir(dir) : [];
      expect(left.filter((f) => !f.startsWith('.'))).toEqual([]);
      expect(left).toEqual([]); // not even a partial .upload-* file
    });

    it('is per company: one full company does not block another', async () => {
      const full = await newCompany('Full');
      await query(
        `INSERT INTO media (company_id, kind, original_name, mime, size_bytes, sha256) VALUES ($1, 'image', 'big.jpg', 'image/jpeg', $2, 'abc')`,
        [full, 5 * 1024 * 1024],
      );
      const other = await newCompany('Other');
      expect((await upload(full)).statusCode).toBe(413);
      expect((await upload(other)).statusCode).toBe(201);
    });
  });

  it('leaves no stored file behind when recording the upload fails', async () => {
    // Force the INSERT to fail after the file has been moved into place, by making the
    // media table refuse rows for this company. The renamed file used to be orphaned:
    // the cleanup only removed the temporary name, which no longer existed.
    const company = await newCompany('InsertFails');
    await query(`ALTER TABLE media ADD CONSTRAINT zz_test_no_insert CHECK (company_id <> '${company}'::uuid) NOT VALID`);
    try {
      const res = await upload(company);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const dir = path.join(mediaDir, company);
      expect((await exists(dir)) ? await readdir(dir) : []).toEqual([]);
    } finally {
      await query('ALTER TABLE media DROP CONSTRAINT zz_test_no_insert');
    }
  });
});
