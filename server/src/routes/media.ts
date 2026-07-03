import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { z } from 'zod';
import { config, SIGNED_URL_TTL_S } from '../config.js';
import { query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { signDownload, verifyDownload } from '../lib/crypto.js';
import { canAccessCompany } from '../lib/permissions.js';
import { sniffMediaType } from '../lib/uploads.js';
import { requireUser } from '../plugins/auth.js';
import { notifyCompany } from '../ws.js';

/** Media lives at MEDIA_DIR/<companyId>/<mediaId>.<ext> - server-generated names only. */
export function mediaPath(companyId: string, mediaId: string, ext: string): string {
  return path.join(config.MEDIA_DIR, companyId, `${mediaId}.${ext}`);
}

export function extFromMime(mime: string): string {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' }[mime] ?? 'bin';
}

export function mediaRoutes(app: FastifyInstance): void {
  // Authenticated download with a signed, expiring URL (works for <img>/ExoPlayer
  // without headers). Device sync and the admin UI both use these.
  app.get('/api/media/:id/file', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { token, download } = z
      .object({ token: z.string(), download: z.string().optional() })
      .parse(req.query);
    if (!verifyDownload(id, token)) return reply.code(401).send({ error: 'invalid_token' });

    const { rows } = await query<{ company_id: string; mime: string; original_name: string }>(
      'SELECT company_id, mime, original_name FROM media WHERE id = $1',
      [id],
    );
    const media = rows[0];
    if (!media) return reply.code(404).send({ error: 'not_found' });
    const file = mediaPath(media.company_id, id, extFromMime(media.mime));
    try {
      await stat(file);
    } catch {
      return reply.code(404).send({ error: 'file_missing' });
    }
    if (download) {
      const safeName = media.original_name.replace(/[^\w. -]/g, '_');
      reply.header('content-disposition', `attachment; filename="${safeName}"`);
    }
    return reply
      .header('content-type', media.mime)
      .header('cache-control', 'private, max-age=3600')
      .sendFile(path.relative(config.MEDIA_DIR, file));
  });

  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser);

    scope.get('/api/companies/:companyId/media', async (req, reply) => {
      const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
      if (!canAccessCompany(req.principal!, companyId, 'viewer')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const { rows } = await query(
        'SELECT id, kind, original_name, mime, size_bytes, sha256, folder_id, created_at FROM media WHERE company_id = $1 ORDER BY created_at DESC',
        [companyId],
      );
      const expires = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S;
      return reply.send(
        rows.map((m) => ({
          ...m,
          url: `/api/media/${m.id}/file?token=${signDownload(m.id as string, req.principal!.id, expires)}`,
        })),
      );
    });

    // ── Folders ─────────────────────────────────────────────────────────────

    scope.get('/api/companies/:companyId/folders', async (req, reply) => {
      const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
      if (!canAccessCompany(req.principal!, companyId, 'viewer')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const { rows } = await query(
        'SELECT id, parent_id, name FROM media_folders WHERE company_id = $1 ORDER BY name',
        [companyId],
      );
      return reply.send(rows);
    });

    scope.post('/api/companies/:companyId/folders', async (req, reply) => {
      const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
      if (!canAccessCompany(req.principal!, companyId, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const body = z
        .object({ name: z.string().trim().min(1).max(100), parentId: z.string().uuid().nullish() })
        .parse(req.body);
      if (body.parentId) {
        const { rowCount } = await query('SELECT 1 FROM media_folders WHERE id = $1 AND company_id = $2', [
          body.parentId,
          companyId,
        ]);
        if (!rowCount) return reply.code(400).send({ error: 'parent_not_found' });
      }
      const { rows } = await query(
        'INSERT INTO media_folders (company_id, parent_id, name) VALUES ($1, $2, $3) RETURNING id, parent_id, name',
        [companyId, body.parentId ?? null, body.name],
      );
      audit({ userId: req.principal!.id, companyId, action: 'folder.create', entityId: rows[0]!.id as string, ip: req.ip });
      return reply.code(201).send(rows[0]);
    });

    scope.patch('/api/folders/:id', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
      const { rows } = await query<{ company_id: string }>('SELECT company_id FROM media_folders WHERE id = $1', [id]);
      if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
      if (!canAccessCompany(req.principal!, rows[0].company_id, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      await query('UPDATE media_folders SET name = $2 WHERE id = $1', [id, body.name]);
      return reply.send({ ok: true });
    });

    // Delete a folder: contents (media + subfolders) move up to its parent.
    scope.delete('/api/folders/:id', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { rows } = await query<{ company_id: string; parent_id: string | null }>(
        'SELECT company_id, parent_id FROM media_folders WHERE id = $1',
        [id],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
      if (!canAccessCompany(req.principal!, rows[0].company_id, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const parent = rows[0].parent_id;
      await query('UPDATE media SET folder_id = $2 WHERE folder_id = $1', [id, parent]);
      await query('UPDATE media_folders SET parent_id = $2 WHERE parent_id = $1', [id, parent]);
      await query('DELETE FROM media_folders WHERE id = $1', [id]);
      audit({ userId: req.principal!.id, companyId: rows[0].company_id, action: 'folder.delete', entityId: id, ip: req.ip });
      return reply.send({ ok: true });
    });

    // Move media into a folder (null = library root) and/or rename it.
    scope.patch('/api/media/:id', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          folderId: z.string().uuid().nullable().optional(),
          name: z.string().trim().min(1).max(300).optional(),
        })
        .parse(req.body);
      const { rows } = await query<{ company_id: string }>('SELECT company_id FROM media WHERE id = $1', [id]);
      if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
      if (!canAccessCompany(req.principal!, rows[0].company_id, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (body.folderId) {
        const { rowCount } = await query('SELECT 1 FROM media_folders WHERE id = $1 AND company_id = $2', [
          body.folderId,
          rows[0].company_id,
        ]);
        if (!rowCount) return reply.code(400).send({ error: 'folder_not_found' });
      }
      if (body.folderId !== undefined) {
        await query('UPDATE media SET folder_id = $2 WHERE id = $1', [id, body.folderId]);
      }
      if (body.name !== undefined) {
        // Display name only - the file on disk keeps its server-generated name.
        await query('UPDATE media SET original_name = $2 WHERE id = $1', [id, body.name]);
        notifyCompany(rows[0].company_id, { type: 'sync' }); // names appear in manifests
      }
      return reply.send({ ok: true });
    });

    // Duplicate media (copies the file; the copy starts in the same folder).
    scope.post('/api/media/:id/duplicate', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { rows } = await query<{
        company_id: string;
        kind: string;
        original_name: string;
        mime: string;
        size_bytes: string;
        sha256: string;
        folder_id: string | null;
      }>('SELECT company_id, kind, original_name, mime, size_bytes, sha256, folder_id FROM media WHERE id = $1', [id]);
      const source = rows[0];
      if (!source) return reply.code(404).send({ error: 'not_found' });
      if (!canAccessCompany(req.principal!, source.company_id, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const newId = randomUUID();
      const ext = extFromMime(source.mime);
      await copyFile(mediaPath(source.company_id, id, ext), mediaPath(source.company_id, newId, ext));
      const dot = source.original_name.lastIndexOf('.');
      const copyName =
        dot > 0
          ? `${source.original_name.slice(0, dot)} (copy)${source.original_name.slice(dot)}`
          : `${source.original_name} (copy)`;
      const { rows: created } = await query(
        `INSERT INTO media (id, company_id, kind, original_name, mime, size_bytes, sha256, folder_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, kind, original_name, mime, size_bytes, folder_id, created_at`,
        [newId, source.company_id, source.kind, copyName, source.mime, source.size_bytes, source.sha256, source.folder_id, req.principal!.id],
      );
      audit({ userId: req.principal!.id, companyId: source.company_id, action: 'media.duplicate', entityId: newId, ip: req.ip });
      return reply.code(201).send(created[0]);
    });

    scope.post('/api/companies/:companyId/media', async (req, reply) => {
      const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
      if (!canAccessCompany(req.principal!, companyId, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: 'no_file' });

      // Optional target folder, sent as a multipart form field alongside the file.
      const folderField = part.fields['folderId'];
      const folderId =
        folderField && 'value' in folderField && typeof folderField.value === 'string' && folderField.value
          ? folderField.value
          : null;
      if (folderId) {
        const { rowCount } = await query('SELECT 1 FROM media_folders WHERE id = $1 AND company_id = $2', [
          folderId,
          companyId,
        ]);
        if (!rowCount) return reply.code(400).send({ error: 'folder_not_found' });
      }

      const mediaId = randomUUID();
      const dir = path.join(config.MEDIA_DIR, companyId);
      await mkdir(dir, { recursive: true });
      const tmpFile = path.join(dir, `.upload-${mediaId}`);

      // Stream to disk while hashing and sniffing the first bytes.
      const hasher = createHash('sha256');
      let head = Buffer.alloc(0);
      let size = 0;
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hasher.update(chunk);
          size += chunk.length;
          if (head.length < 16) head = Buffer.concat([head, chunk]).subarray(0, 16);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(part.file, tap, createWriteStream(tmpFile, { flags: 'wx', mode: 0o640 }));
        if (part.file.truncated) throw Object.assign(new Error('too_large'), { statusCode: 413 });
        const sniffed = sniffMediaType(head);
        if (!sniffed) throw Object.assign(new Error('unsupported_type'), { statusCode: 415 });

        await rename(tmpFile, mediaPath(companyId, mediaId, sniffed.ext));
        const { rows } = await query(
          `INSERT INTO media (id, company_id, kind, original_name, mime, size_bytes, sha256, folder_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, kind, original_name, mime, size_bytes, sha256, folder_id, created_at`,
          [
            mediaId,
            companyId,
            sniffed.kind,
            path.basename(part.filename ?? 'upload'),
            sniffed.mime,
            size,
            hasher.digest('hex'),
            folderId,
            req.principal!.id,
          ],
        );
        audit({ userId: req.principal!.id, companyId, action: 'media.upload', entityId: mediaId, ip: req.ip });
        notifyCompany(companyId, { type: 'sync' });
        return reply.code(201).send(rows[0]);
      } catch (err) {
        await unlink(tmpFile).catch(() => {});
        throw err;
      }
    });

    scope.delete('/api/media/:id', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { rows } = await query<{ company_id: string; mime: string }>(
        'SELECT company_id, mime FROM media WHERE id = $1',
        [id],
      );
      const media = rows[0];
      if (!media) return reply.code(404).send({ error: 'not_found' });
      if (!canAccessCompany(req.principal!, media.company_id, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      await query('DELETE FROM media WHERE id = $1', [id]);
      await unlink(mediaPath(media.company_id, id, extFromMime(media.mime))).catch(() => {});
      audit({ userId: req.principal!.id, companyId: media.company_id, action: 'media.delete', entityId: id, ip: req.ip });
      notifyCompany(media.company_id, { type: 'sync' });
      return reply.send({ ok: true });
    });
  });
}
