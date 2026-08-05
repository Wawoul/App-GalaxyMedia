import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { z } from 'zod';
import { config, SIGNED_URL_TTL_S } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { signDownload, verifyDownload } from '../lib/crypto.js';
import { canAccessCompany } from '../lib/permissions.js';
import { fetchRemoteFile } from '../lib/fetchUrl.js';
import { extFromMime, sniffMediaType } from '../lib/uploads.js';
import { requireUser } from '../plugins/auth.js';
import { notifyCompany } from '../ws.js';

/** Media lives at MEDIA_DIR/<companyId>/<mediaId>.<ext> - server-generated names only. */
export function mediaPath(companyId: string, mediaId: string, ext: string): string {
  return path.join(config.MEDIA_DIR, companyId, `${mediaId}.${ext}`);
}

/**
 * Streams `source` to disk, hashing and content-sniffing as it goes, then
 * records it. Shared by the browser upload and the fetch-from-URL import so the
 * two can't drift apart on validation - the sniff in particular is the only
 * thing standing between "an admin pasted a link" and "we stored a .exe".
 *
 * `maxBytes` is enforced here rather than trusted from a Content-Length, since
 * a remote server can lie about or omit it.
 */
async function storeMediaStream(opts: {
  companyId: string;
  userId: string;
  folderId: string | null;
  originalName: string;
  source: NodeJS.ReadableStream;
  maxBytes: number;
}): Promise<Record<string, unknown>> {
  const mediaId = randomUUID();
  const dir = path.join(config.MEDIA_DIR, opts.companyId);
  await mkdir(dir, { recursive: true });
  const tmpFile = path.join(dir, `.upload-${mediaId}`);

  const hasher = createHash('sha256');
  let head = Buffer.alloc(0);
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > opts.maxBytes) {
        cb(Object.assign(new Error('too_large'), { statusCode: 413 }));
        return;
      }
      hasher.update(chunk);
      if (head.length < 64) head = Buffer.concat([head, chunk]).subarray(0, 64);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(opts.source, tap, createWriteStream(tmpFile, { flags: 'wx', mode: 0o640 }));
    const sniffed = sniffMediaType(head);
    if (!sniffed) throw Object.assign(new Error('unsupported_type'), { statusCode: 415 });

    await rename(tmpFile, mediaPath(opts.companyId, mediaId, sniffed.ext));
    const { rows } = await query(
      `INSERT INTO media (id, company_id, kind, original_name, mime, size_bytes, sha256, folder_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, kind, original_name, mime, size_bytes, sha256, folder_id, created_at`,
      [
        mediaId,
        opts.companyId,
        sniffed.kind,
        opts.originalName,
        sniffed.mime,
        size,
        hasher.digest('hex'),
        opts.folderId,
        opts.userId,
      ],
    );
    return rows[0]!;
  } catch (err) {
    await unlink(tmpFile).catch(() => {});
    throw err;
  }
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
      const { recursive } = z.object({ recursive: z.enum(['true', 'false']).optional() }).parse(req.query);
      const { rows } = await query<{ company_id: string; parent_id: string | null }>(
        'SELECT company_id, parent_id FROM media_folders WHERE id = $1',
        [id],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
      const companyId = rows[0].company_id;
      if (!canAccessCompany(req.principal!, companyId, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      if (recursive === 'true') {
        // Permanently delete the folder, every subfolder beneath it, and every
        // media file inside any of them (not just moved up - actually gone).
        // Rows first, files after commit: the DELETE's RETURNING is the
        // authoritative file list (no TOCTOU with concurrent moves/uploads),
        // and a failed transaction never leaves rows pointing at unlinked files.
        const deleted = await withTransaction(async (tx) => {
          // UNION (not ALL) + company scoping: terminates even on a corrupt
          // parent_id cycle and can never cross a tenant boundary.
          const { rows: subtree } = await tx.query<{ id: string }>(
            `WITH RECURSIVE subtree AS (
               SELECT id FROM media_folders WHERE id = $1 AND company_id = $2
               UNION
               SELECT f.id FROM media_folders f JOIN subtree s ON f.parent_id = s.id
               WHERE f.company_id = $2
             )
             SELECT id FROM subtree`,
            [id, companyId],
          );
          const folderIds = subtree.map((f) => f.id);
          const { rows: mediaRows } = await tx.query<{ id: string; mime: string }>(
            'DELETE FROM media WHERE folder_id = ANY($1::uuid[]) RETURNING id, mime',
            [folderIds],
          );
          await tx.query('DELETE FROM media_folders WHERE id = ANY($1::uuid[])', [folderIds]);
          return { folderIds, mediaRows };
        });
        for (const m of deleted.mediaRows) {
          await unlink(mediaPath(companyId, m.id, extFromMime(m.mime))).catch(() => {});
        }
        audit({
          userId: req.principal!.id,
          companyId,
          action: 'folder.delete_recursive',
          entityId: id,
          ip: req.ip,
          detail: { foldersDeleted: deleted.folderIds.length, mediaDeleted: deleted.mediaRows.length },
        });
        notifyCompany(companyId, { type: 'sync' }); // playlists referencing deleted media need to refresh
        return reply.send({ ok: true, foldersDeleted: deleted.folderIds.length, mediaDeleted: deleted.mediaRows.length });
      }

      const parent = rows[0].parent_id;
      // One transaction: media_folders.parent_id cascades on delete, so if the
      // reparenting above had failed while the DELETE below succeeded, the
      // cascade would silently destroy the whole subtree this endpoint promises
      // to move up a level.
      await withTransaction(async (tx) => {
        await tx.query('UPDATE media SET folder_id = $2 WHERE folder_id = $1', [id, parent]);
        await tx.query('UPDATE media_folders SET parent_id = $2 WHERE parent_id = $1', [id, parent]);
        await tx.query('DELETE FROM media_folders WHERE id = $1', [id]);
      });
      audit({ userId: req.principal!.id, companyId, action: 'folder.delete', entityId: id, ip: req.ip });
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
      // The upload path already cleans up its file when the insert fails; this
      // one didn't, so every failed duplicate leaked a full-size orphan with no
      // row pointing at it and nothing to ever collect it.
      let created;
      try {
        ({ rows: created } = await query(
          `INSERT INTO media (id, company_id, kind, original_name, mime, size_bytes, sha256, folder_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, kind, original_name, mime, size_bytes, folder_id, created_at`,
          [newId, source.company_id, source.kind, copyName, source.mime, source.size_bytes, source.sha256, source.folder_id, req.principal!.id],
        ));
      } catch (err) {
        await unlink(mediaPath(source.company_id, newId, ext)).catch(() => {});
        throw err;
      }
      audit({ userId: req.principal!.id, companyId: source.company_id, action: 'media.duplicate', entityId: newId, ip: req.ip });
      return reply.code(201).send(created[0]);
    });

    /**
     * Import media by URL: the server fetches the file itself, so nothing large
     * traverses the admin's connection. This is the answer to a proxy that caps
     * request bodies - Cloudflare's free plan stops uploads at 100MB, and a
     * 300MB video simply cannot be POSTed through it - as well as to slow
     * office uplinks, since the server usually has the better connection.
     *
     * Runs long: a big file over a slow origin can take many minutes, so the
     * response is deliberately sent only once the file is stored and verified.
     */
    scope.post('/api/companies/:companyId/media/import', async (req, reply) => {
      const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
      if (!canAccessCompany(req.principal!, companyId, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const body = z
        .object({
          url: z.string().url().max(2000),
          folderId: z.string().uuid().nullish(),
          name: z.string().trim().min(1).max(300).nullish(),
        })
        .parse(req.body);

      if (body.folderId) {
        const { rowCount } = await query(
          'SELECT 1 FROM media_folders WHERE id = $1 AND company_id = $2',
          [body.folderId, companyId],
        );
        if (!rowCount) return reply.code(400).send({ error: 'folder_not_found' });
      }

      const maxBytes = config.MAX_UPLOAD_MB * 1024 * 1024;
      const remote = await fetchRemoteFile(body.url, { maxBytes });
      const created = await storeMediaStream({
        companyId,
        userId: req.principal!.id,
        folderId: body.folderId ?? null,
        originalName: body.name?.trim() || remote.suggestedName,
        source: remote.body,
        maxBytes,
      });
      audit({
        userId: req.principal!.id,
        companyId,
        action: 'media.import_url',
        entityId: created.id as string,
        ip: req.ip,
        detail: { url: body.url.slice(0, 200) },
      });
      notifyCompany(companyId, { type: 'sync' });
      return reply.code(201).send(created);
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

      const created = await storeMediaStream({
        companyId,
        userId: req.principal!.id,
        folderId,
        originalName: path.basename(part.filename ?? 'upload'),
        source: part.file,
        maxBytes: config.MAX_UPLOAD_MB * 1024 * 1024,
      });
      // multipart's own limit truncates rather than throwing, so check it too.
      if (part.file.truncated) {
        await unlink(mediaPath(companyId, created.id as string, extFromMime(created.mime as string)))
          .catch(() => {});
        await query('DELETE FROM media WHERE id = $1', [created.id]);
        return reply.code(413).send({ error: 'too_large' });
      }
      audit({
        userId: req.principal!.id,
        companyId,
        action: 'media.upload',
        entityId: created.id as string,
        ip: req.ip,
      });
      notifyCompany(companyId, { type: 'sync' });
      return reply.code(201).send(created);
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
