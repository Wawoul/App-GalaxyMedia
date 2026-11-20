import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { copyFile, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { designDocSchema, isLiveDoc, MAX_DESIGN_DOC_BYTES, parseDesignDoc, referencedMediaIds } from '../lib/designDoc.js';
import { liveUrl, liveUrlPattern } from '../lib/liveSlides.js';
import { canAccessCompany } from '../lib/permissions.js';
import { checkRoom } from '../lib/quota.js';
import { extFromMime } from '../lib/uploads.js';
import { requireUser } from '../plugins/auth.js';
import { notifyCompany } from '../ws.js';
import { mediaPath, roomError, storeMediaStream } from './media.js';

/** A rendered slide is a 1080p PNG; far below the general upload cap. */
const MAX_RENDER_BYTES = Math.min(config.MAX_UPLOAD_MB, 40) * 1024 * 1024;

const sizeSchema = z
  .object({
    width: z.coerce.number().int(),
    height: z.coerce.number().int(),
  })
  .refine((s) => (s.width === 1920 && s.height === 1080) || (s.width === 1080 && s.height === 1920), {
    message: 'size must be 1920x1080 or 1080x1920',
  });

const nameSchema = z.string().trim().min(1).max(200);

/** A multipart text field. Fields are only visible if the client sent them BEFORE the file. */
function field(part: { fields: Record<string, unknown> }, key: string): string | undefined {
  const f = part.fields[key] as { value?: unknown } | undefined;
  return f && typeof f.value === 'string' ? f.value : undefined;
}

interface DesignRow {
  id: string;
  company_id: string;
  width: number;
  height: number;
  media_id: string | null;
  is_template: boolean;
  live: boolean;
  version: number;
}

const SUMMARY = 'id, company_id, name, width, height, media_id, is_template, live, version, created_at, updated_at';

/** A live slide is played from its page; clients need that link to recognise its playlist entries. */
const withLive = <T extends { id: string; live?: boolean }>(row: T): T & { live_url?: string } =>
  row.live ? { ...row, live_url: liveUrl(row.id) } : row;

/** Image layers must come from the same company's library. */
async function mediaBelongsTo(companyId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const { rows } = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM media WHERE company_id = $1 AND id = ANY($2::uuid[])',
    [companyId, ids],
  );
  return Number(rows[0]?.n ?? 0) === ids.length;
}

async function discardMedia(companyId: string, mediaId: string, mime: string): Promise<void> {
  await query('DELETE FROM media WHERE id = $1', [mediaId]);
  await unlink(mediaPath(companyId, mediaId, extFromMime(mime))).catch(() => {});
}

/** The stored document always carries its own size, so undo/redo and reopening agree with the columns. */
const withSize = <T extends object>(doc: T, width: number, height: number) => ({ ...doc, size: { width, height } });

export function designRoutes(app: FastifyInstance): void {
  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser);

    // Slides (published, with a rendered image) or templates (?templates=true, with their preview).
    scope.get('/api/companies/:companyId/designs', async (req, reply) => {
      const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
      const q = z.object({ templates: z.enum(['true', 'false']).default('false') }).parse(req.query);
      if (!canAccessCompany(req.principal!, companyId, 'viewer')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const templates = q.templates === 'true';
      const { rows } = await query(
        `SELECT ${SUMMARY}${templates ? ", document->>'preview' AS preview" : ''}
         FROM designs WHERE company_id = $1 AND is_template = $2 ORDER BY updated_at DESC`,
        [companyId, templates],
      );
      return reply.send(rows.map((r) => withLive(r as { id: string; live?: boolean })));
    });

    scope.get('/api/designs/:id', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { rows } = await query<DesignRow>(`SELECT ${SUMMARY}, document FROM designs WHERE id = $1`, [id]);
      const design = rows[0];
      if (!design) return reply.code(404).send({ error: 'not_found' });
      if (!canAccessCompany(req.principal!, design.company_id, 'viewer')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      return reply.send(withLive(design));
    });

    /**
     * Publish a new slide: multipart with text fields first (name, width, height, doc,
     * optional playlistId / durationMs / folderId) and the rendered PNG LAST. When a
     * playlist is given the slide is appended to it in the same request.
     */
    scope.post('/api/companies/:companyId/designs', async (req, reply) => {
      const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
      if (!canAccessCompany(req.principal!, companyId, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const room = await checkRoom(companyId, Number(req.headers['content-length']));
      if (room !== 'ok') {
        const { status, error } = roomError(room);
        return reply.code(status).send({ error });
      }
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: 'no_file' });

      const meta = z
        .object({
          name: nameSchema,
          playlistId: z.string().uuid().optional(),
          folderId: z.string().uuid().optional(),
          durationMs: z.coerce.number().int().min(1000).max(24 * 3600 * 1000).optional(),
        })
        .and(sizeSchema)
        .parse({
          name: field(part, 'name'),
          width: field(part, 'width'),
          height: field(part, 'height'),
          playlistId: field(part, 'playlistId') || undefined,
          folderId: field(part, 'folderId') || undefined,
          durationMs: field(part, 'durationMs') || undefined,
        });
      const doc = parseDesignDoc(field(part, 'doc'));
      if (!(await mediaBelongsTo(companyId, referencedMediaIds(doc)))) {
        return reply.code(400).send({ error: 'media_not_found' });
      }
      if (meta.playlistId) {
        const { rowCount } = await query('SELECT 1 FROM playlists WHERE id = $1 AND company_id = $2', [meta.playlistId, companyId]);
        if (!rowCount) return reply.code(400).send({ error: 'playlist_not_found' });
      }
      if (meta.folderId) {
        const { rowCount } = await query('SELECT 1 FROM media_folders WHERE id = $1 AND company_id = $2', [meta.folderId, companyId]);
        if (!rowCount) return reply.code(400).send({ error: 'folder_not_found' });
      }

      const media = await storeMediaStream({
        companyId,
        userId: req.principal!.id,
        folderId: meta.folderId ?? null,
        originalName: `${meta.name}.png`,
        source: part.file,
        maxBytes: MAX_RENDER_BYTES,
      });
      if (part.file.truncated || media.mime !== 'image/png') {
        await discardMedia(companyId, media.id as string, media.mime as string);
        return reply.code(part.file.truncated ? 413 : 415).send({ error: part.file.truncated ? 'too_large' : 'unsupported_type' });
      }

      const live = isLiveDoc(doc);
      try {
        const design = await withTransaction(async (tx) => {
          const { rows } = await tx.query(
            `INSERT INTO designs (company_id, name, width, height, document, media_id, live, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${SUMMARY}`,
            [companyId, meta.name, meta.width, meta.height, JSON.stringify(withSize(doc, meta.width, meta.height)), media.id, live, req.principal!.id],
          );
          if (meta.playlistId) {
            await tx.query('SELECT 1 FROM playlists WHERE id = $1 FOR UPDATE', [meta.playlistId]);
            // A live slide goes in as a web page (its link), a still one as the rendered image.
            await tx.query(
              `INSERT INTO playlist_items (playlist_id, position, media_id, url, duration_ms)
               SELECT $1, coalesce(max(position) + 1, 0), $2::uuid, $3::text, $4 FROM playlist_items WHERE playlist_id = $1`,
              [meta.playlistId, live ? null : media.id, live ? liveUrl(rows[0]!.id as string) : null, meta.durationMs ?? null],
            );
          }
          return rows[0]!;
        });
        audit({ userId: req.principal!.id, companyId, action: 'design.create', entityId: design.id as string, ip: req.ip });
        notifyCompany(companyId, { type: 'sync' });
        return reply.code(201).send(withLive(design as { id: string; live?: boolean }));
      } catch (err) {
        await discardMedia(companyId, media.id as string, media.mime as string);
        throw err;
      }
    });

    /**
     * Save changes to a slide. Publishes the new render as a NEW media row and swaps every
     * playlist item over to it (see migration 018 for why not in place), then retires the
     * old file. Multipart: name, doc, baseVersion (the version the editor opened; 409 when
     * someone saved since, unless force=1), optional width/height, then the PNG.
     */
    scope.put('/api/designs/:id', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { rows } = await query<DesignRow>(
        'SELECT id, company_id, width, height, media_id, is_template, version FROM designs WHERE id = $1',
        [id],
      );
      const design = rows[0];
      if (!design) return reply.code(404).send({ error: 'not_found' });
      if (!canAccessCompany(req.principal!, design.company_id, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (design.is_template || !design.media_id) return reply.code(400).send({ error: 'is_template' });
      const companyId = design.company_id;
      const room = await checkRoom(companyId, Number(req.headers['content-length']));
      if (room !== 'ok') {
        const { status, error } = roomError(room);
        return reply.code(status).send({ error });
      }
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: 'no_file' });

      const meta = z
        .object({
          name: nameSchema,
          baseVersion: z.coerce.number().int().min(1).optional(),
          force: z.literal('1').optional(),
        })
        .and(sizeSchema)
        .parse({
          name: field(part, 'name'),
          baseVersion: field(part, 'baseVersion') || undefined,
          force: field(part, 'force') || undefined,
          width: field(part, 'width') ?? String(design.width),
          height: field(part, 'height') ?? String(design.height),
        });
      if (!meta.force && meta.baseVersion === undefined) return reply.code(400).send({ error: 'base_version_required' });
      // Cheap early refusal; the authoritative check is repeated under the row lock below.
      if (!meta.force && meta.baseVersion !== design.version) return reply.code(409).send({ error: 'conflict' });

      const doc = parseDesignDoc(field(part, 'doc'));
      const live = isLiveDoc(doc);
      if (!(await mediaBelongsTo(companyId, referencedMediaIds(doc)))) {
        return reply.code(400).send({ error: 'media_not_found' });
      }
      const folderId = (await query<{ folder_id: string | null }>('SELECT folder_id FROM media WHERE id = $1', [design.media_id])).rows[0]?.folder_id ?? null;

      const media = await storeMediaStream({
        companyId,
        userId: req.principal!.id,
        folderId,
        originalName: `${meta.name}.png`,
        source: part.file,
        maxBytes: MAX_RENDER_BYTES,
      });
      if (part.file.truncated || media.mime !== 'image/png') {
        await discardMedia(companyId, media.id as string, media.mime as string);
        return reply.code(part.file.truncated ? 413 : 415).send({ error: part.file.truncated ? 'too_large' : 'unsupported_type' });
      }

      let result: { row: Record<string, unknown>; oldId: string; oldMime: string | null };
      try {
        result = await withTransaction(async (tx) => {
          // Lock the design so two saves cannot interleave: the loser would otherwise leave an
          // orphaned file and a playlist pointing at a different version than the stored design.
          const cur = (await tx.query<{ media_id: string; version: number }>(
            'SELECT media_id, version FROM designs WHERE id = $1 FOR UPDATE', [id],
          )).rows[0];
          if (!cur) throw Object.assign(new Error('not_found'), { statusCode: 404 });
          if (!meta.force && cur.version !== meta.baseVersion) throw Object.assign(new Error('conflict'), { statusCode: 409 });
          // Keep every playlist showing the slide the way it now needs to be shown:
          //  - live: entries become web-page items pointing at the slide's page (already-live entries stay);
          //  - still: entries (whether they held the old image or the live link) point at the new image.
          if (live) {
            await tx.query('UPDATE playlist_items SET media_id = NULL, url = $2 WHERE media_id = $1', [cur.media_id, liveUrl(id)]);
          } else {
            await tx.query('UPDATE playlist_items SET media_id = $2 WHERE media_id = $1', [cur.media_id, media.id]);
            await tx.query('UPDATE playlist_items SET media_id = $2, url = NULL WHERE url LIKE $1', [liveUrlPattern(id), media.id]);
          }
          const r = await tx.query(
            `UPDATE designs SET name = $2, width = $3, height = $4, document = $5, media_id = $6, live = $7,
                    version = version + 1, updated_at = now()
             WHERE id = $1 RETURNING ${SUMMARY}`,
            [id, meta.name, meta.width, meta.height, JSON.stringify(withSize(doc, meta.width, meta.height)), media.id, live],
          );
          const oldMime = (await tx.query<{ mime: string }>('SELECT mime FROM media WHERE id = $1', [cur.media_id])).rows[0]?.mime ?? null;
          // Only after the design points at the new file: deleting media cascades to designs.
          await tx.query('DELETE FROM media WHERE id = $1', [cur.media_id]);
          return { row: r.rows[0]!, oldId: cur.media_id, oldMime };
        });
      } catch (err) {
        await discardMedia(companyId, media.id as string, media.mime as string);
        throw err;
      }
      if (result.oldMime) await unlink(mediaPath(companyId, result.oldId, extFromMime(result.oldMime))).catch(() => {});
      audit({ userId: req.principal!.id, companyId, action: 'design.update', entityId: id, ip: req.ip });
      notifyCompany(companyId, { type: 'sync' });
      return reply.send(withLive(result.row as { id: string; live?: boolean }));
    });

    // Templates are only ever a saved document - nothing is rendered or published.
    scope.post('/api/companies/:companyId/design-templates', async (req, reply) => {
      const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
      if (!canAccessCompany(req.principal!, companyId, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const body = z.object({ name: nameSchema, document: designDocSchema }).and(sizeSchema).parse(req.body);
      if (JSON.stringify(body.document).length > MAX_DESIGN_DOC_BYTES) return reply.code(400).send({ error: 'invalid_design' });
      if (!(await mediaBelongsTo(companyId, referencedMediaIds(body.document)))) {
        return reply.code(400).send({ error: 'media_not_found' });
      }
      const { rows } = await query(
        `INSERT INTO designs (company_id, name, width, height, document, is_template, created_by)
         VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING ${SUMMARY}`,
        [companyId, body.name, body.width, body.height, JSON.stringify(withSize(body.document, body.width, body.height)), req.principal!.id],
      );
      audit({ userId: req.principal!.id, companyId, action: 'design.template', entityId: rows[0]!.id as string, ip: req.ip });
      return reply.code(201).send(rows[0]);
    });

    /**
     * Copy a slide (own rendered file, same document) - "Clone slide". With playlistId the copy is
     * appended to that playlist. A template copies as a template.
     */
    scope.post('/api/designs/:id/duplicate', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z.object({ playlistId: z.string().uuid().optional() }).parse(req.body ?? {});
      const { rows } = await query<DesignRow & { name: string; document: unknown }>(
        `SELECT ${SUMMARY}, document FROM designs WHERE id = $1`, [id],
      );
      const src = rows[0];
      if (!src) return reply.code(404).send({ error: 'not_found' });
      if (!canAccessCompany(req.principal!, src.company_id, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const companyId = src.company_id;
      const copyName = `${src.name} (copy)`.slice(0, 200);

      if (src.is_template || !src.media_id) {
        const ins = await query(
          `INSERT INTO designs (company_id, name, width, height, document, is_template, created_by)
           VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING ${SUMMARY}`,
          [companyId, copyName, src.width, src.height, JSON.stringify(src.document), req.principal!.id],
        );
        return reply.code(201).send(ins.rows[0]);
      }
      if (body.playlistId) {
        const { rowCount } = await query('SELECT 1 FROM playlists WHERE id = $1 AND company_id = $2', [body.playlistId, companyId]);
        if (!rowCount) return reply.code(400).send({ error: 'playlist_not_found' });
      }
      const m = (await query<{ mime: string; size_bytes: string; sha256: string; folder_id: string | null }>(
        'SELECT mime, size_bytes, sha256, folder_id FROM media WHERE id = $1', [src.media_id],
      )).rows[0];
      if (!m) return reply.code(404).send({ error: 'not_found' });
      const roomCheck = await checkRoom(companyId, Number(m.size_bytes));
      if (roomCheck !== 'ok') {
        const { status, error } = roomError(roomCheck);
        return reply.code(status).send({ error });
      }
      const newMediaId = randomUUID();
      const ext = extFromMime(m.mime);
      await copyFile(mediaPath(companyId, src.media_id, ext), mediaPath(companyId, newMediaId, ext));
      try {
        const design = await withTransaction(async (tx) => {
          await tx.query(
            `INSERT INTO media (id, company_id, kind, original_name, mime, size_bytes, sha256, folder_id, created_by)
             VALUES ($1, $2, 'image', $3, $4, $5, $6, $7, $8)`,
            [newMediaId, companyId, `${copyName}.png`, m.mime, m.size_bytes, m.sha256, m.folder_id, req.principal!.id],
          );
          const ins = await tx.query(
            `INSERT INTO designs (company_id, name, width, height, document, media_id, live, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${SUMMARY}`,
            [companyId, copyName, src.width, src.height, JSON.stringify(src.document), newMediaId, src.live, req.principal!.id],
          );
          if (body.playlistId) {
            await tx.query('SELECT 1 FROM playlists WHERE id = $1 FOR UPDATE', [body.playlistId]);
            await tx.query(
              `INSERT INTO playlist_items (playlist_id, position, media_id, url, duration_ms)
               SELECT $1, coalesce(max(position) + 1, 0), $2::uuid, $3::text, 10000 FROM playlist_items WHERE playlist_id = $1`,
              [body.playlistId, src.live ? null : newMediaId, src.live ? liveUrl(ins.rows[0]!.id as string) : null],
            );
          }
          return ins.rows[0]!;
        });
        audit({ userId: req.principal!.id, companyId, action: 'design.duplicate', entityId: design.id as string, ip: req.ip });
        notifyCompany(companyId, { type: 'sync' });
        return reply.code(201).send(withLive(design as { id: string; live?: boolean }));
      } catch (err) {
        await unlink(mediaPath(companyId, newMediaId, ext)).catch(() => {});
        throw err;
      }
    });

    // Deleting a slide also deletes its rendered image (and so removes it from playlists).
    scope.delete('/api/designs/:id', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { rows } = await query<DesignRow>('SELECT id, company_id, width, height, media_id, is_template, version FROM designs WHERE id = $1', [id]);
      const design = rows[0];
      if (!design) return reply.code(404).send({ error: 'not_found' });
      if (!canAccessCompany(req.principal!, design.company_id, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (design.media_id) {
        const m = (await query<{ mime: string }>('SELECT mime FROM media WHERE id = $1', [design.media_id])).rows[0];
        await query('DELETE FROM media WHERE id = $1', [design.media_id]); // cascades to the design
        if (m) await unlink(mediaPath(design.company_id, design.media_id, extFromMime(m.mime))).catch(() => {});
      } else {
        await query('DELETE FROM designs WHERE id = $1', [id]);
      }
      audit({ userId: req.principal!.id, companyId: design.company_id, action: 'design.delete', entityId: id, ip: req.ip });
      notifyCompany(design.company_id, { type: 'sync' });
      return reply.send({ ok: true });
    });
  });
}
