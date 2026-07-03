import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { canAccessCompany } from '../lib/permissions.js';
import { requireUser } from '../plugins/auth.js';
import { notifyCompany } from '../ws.js';

const itemSchema = z
  .object({
    mediaId: z.string().uuid().nullish(),
    url: z.string().url().max(2000).nullish(),
    durationMs: z.number().int().min(1000).max(24 * 3600 * 1000).nullish(),
    enabled: z.boolean().default(true),
    muted: z.boolean().default(false),
  })
  .refine((i) => (i.mediaId ? !i.url : !!i.url), { message: 'item needs exactly one of mediaId/url' });

async function playlistCompany(playlistId: string): Promise<string | null> {
  const { rows } = await query<{ company_id: string }>('SELECT company_id FROM playlists WHERE id = $1', [playlistId]);
  return rows[0]?.company_id ?? null;
}

export function playlistRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', requireUser);

  app.get('/api/companies/:companyId/playlists', async (req, reply) => {
    const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
    if (!canAccessCompany(req.principal!, companyId, 'viewer')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const { rows } = await query(
      `SELECT p.*, (SELECT count(*) FROM playlist_items i WHERE i.playlist_id = p.id)::int AS item_count
       FROM playlists p WHERE p.company_id = $1 ORDER BY p.name`,
      [companyId],
    );
    return reply.send(rows);
  });

  app.post('/api/companies/:companyId/playlists', async (req, reply) => {
    const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
    if (!canAccessCompany(req.principal!, companyId, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const body = z.object({ name: z.string().trim().min(1).max(200) }).parse(req.body);
    const { rows } = await query('INSERT INTO playlists (company_id, name) VALUES ($1, $2) RETURNING *', [
      companyId,
      body.name,
    ]);
    audit({ userId: req.principal!.id, companyId, action: 'playlist.create', entityId: rows[0]!.id as string, ip: req.ip });
    return reply.code(201).send(rows[0]);
  });

  app.get('/api/playlists/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const companyId = await playlistCompany(id);
    if (!companyId) return reply.code(404).send({ error: 'not_found' });
    if (!canAccessCompany(req.principal!, companyId, 'viewer')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const { rows: items } = await query(
      `SELECT i.id, i.position, i.media_id, i.url, i.duration_ms, i.enabled, i.muted,
              m.kind, m.original_name, m.mime
       FROM playlist_items i LEFT JOIN media m ON m.id = i.media_id
       WHERE i.playlist_id = $1 ORDER BY i.position`,
      [id],
    );
    const { rows: pl } = await query('SELECT * FROM playlists WHERE id = $1', [id]);
    return reply.send({ ...pl[0], items });
  });

  // Replace the full item list (simple, transactional; the UI sends the whole
  // ordered list after drag-reorder).
  app.put('/api/playlists/:id/items', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const companyId = await playlistCompany(id);
    if (!companyId) return reply.code(404).send({ error: 'not_found' });
    if (!canAccessCompany(req.principal!, companyId, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const body = z.object({ items: z.array(itemSchema).max(500) }).parse(req.body);

    await withTransaction(async (tx) => {
      // All referenced media must belong to this company (tenant isolation).
      const mediaIds = body.items.flatMap((i) => (i.mediaId ? [i.mediaId] : []));
      if (mediaIds.length > 0) {
        const owned = await tx.query<{ id: string }>(
          'SELECT id FROM media WHERE id = ANY($1) AND company_id = $2',
          [mediaIds, companyId],
        );
        if (new Set(owned.rows.map((r) => r.id)).size !== new Set(mediaIds).size) {
          throw Object.assign(new Error('media_not_in_company'), { statusCode: 400 });
        }
      }
      await tx.query('DELETE FROM playlist_items WHERE playlist_id = $1', [id]);
      for (const [position, item] of body.items.entries()) {
        await tx.query(
          `INSERT INTO playlist_items (playlist_id, position, media_id, url, duration_ms, enabled, muted)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, position, item.mediaId ?? null, item.url ?? null, item.durationMs ?? null, item.enabled, item.muted],
        );
      }
    });
    audit({ userId: req.principal!.id, companyId, action: 'playlist.update_items', entityId: id, ip: req.ip });
    notifyCompany(companyId, { type: 'sync' });
    return reply.send({ ok: true });
  });

  app.patch('/api/playlists/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const companyId = await playlistCompany(id);
    if (!companyId) return reply.code(404).send({ error: 'not_found' });
    if (!canAccessCompany(req.principal!, companyId, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const body = z.object({ name: z.string().trim().min(1).max(200) }).parse(req.body);
    await query('UPDATE playlists SET name = $2 WHERE id = $1', [id, body.name]);
    return reply.send({ ok: true });
  });

  app.delete('/api/playlists/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const companyId = await playlistCompany(id);
    if (!companyId) return reply.code(404).send({ error: 'not_found' });
    if (!canAccessCompany(req.principal!, companyId, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    await query('DELETE FROM playlists WHERE id = $1', [id]);
    audit({ userId: req.principal!.id, companyId, action: 'playlist.delete', entityId: id, ip: req.ip });
    notifyCompany(companyId, { type: 'sync' });
    return reply.send({ ok: true });
  });

  // ── Assignments (Phase 1: default playlist per screen/group) ─────────────

  app.get('/api/companies/:companyId/assignments', async (req, reply) => {
    const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
    if (!canAccessCompany(req.principal!, companyId, 'viewer')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const { rows } = await query(
      `SELECT a.*, coalesce(p.name, l.name, 'Black Screen') AS playlist_name,
              s.name AS screen_name, g.name AS group_name
       FROM assignments a
       LEFT JOIN playlists p ON p.id = a.playlist_id
       LEFT JOIN layouts l ON l.id = a.layout_id
       LEFT JOIN screens s ON s.id = a.screen_id
       LEFT JOIN screen_groups g ON g.id = a.group_id
       WHERE a.company_id = $1 ORDER BY a.created_at DESC`,
      [companyId],
    );
    return reply.send(rows);
  });

  app.post('/api/companies/:companyId/assignments', async (req, reply) => {
    const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
    if (!canAccessCompany(req.principal!, companyId, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const body = z
      .object({
        playlistId: z.string().uuid().nullish(),
        layoutId: z.string().uuid().nullish(), // split-screen layout instead of a playlist
        blackout: z.boolean().default(false), // Black Screen: no playlist, TV renders black
        screenId: z.string().uuid().nullish(),
        groupId: z.string().uuid().nullish(),
        // Schedule (all optional; omitted = always-on default assignment)
        priority: z.number().int().min(0).max(1000).default(0),
        daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).nullish(),
        startTime: z.string().regex(timeRe).nullish(),
        endTime: z.string().regex(timeRe).nullish(),
        startDate: z.string().regex(dateRe).nullish(),
        endDate: z.string().regex(dateRe).nullish(),
        weekInterval: z.number().int().min(1).max(8).default(1),
      })
      .refine((b) => (b.screenId ? !b.groupId : !!b.groupId), {
        message: 'exactly one of screenId/groupId',
      })
      .refine((b) => !!b.startTime === !!b.endTime, {
        message: 'startTime and endTime must be set together',
      })
      .refine((b) => b.weekInterval === 1 || !!b.startDate, {
        message: 'recurrence intervals need a startDate anchor',
      })
      .refine((b) => Number(!!b.playlistId) + Number(!!b.layoutId) + Number(b.blackout) === 1, {
        message: 'exactly one of playlistId/layoutId/blackout',
      })
      .parse(req.body);

    // Content (unless blackout) and target must belong to this company.
    const checks = await Promise.all([
      body.blackout
        ? Promise.resolve({ rowCount: 1 })
        : body.layoutId
          ? query('SELECT 1 FROM layouts WHERE id = $1 AND company_id = $2', [body.layoutId, companyId])
          : query('SELECT 1 FROM playlists WHERE id = $1 AND company_id = $2', [body.playlistId, companyId]),
      body.screenId
        ? query('SELECT 1 FROM screens WHERE id = $1 AND company_id = $2', [body.screenId, companyId])
        : query('SELECT 1 FROM screen_groups WHERE id = $1 AND company_id = $2', [body.groupId, companyId]),
    ]);
    if (checks.some((c) => c.rowCount === 0)) return reply.code(400).send({ error: 'cross_company' });

    const { rows } = await query(
      `INSERT INTO assignments
         (company_id, playlist_id, layout_id, screen_id, group_id, priority, days_of_week,
          start_time, end_time, start_date, end_date, week_interval, blackout)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        companyId,
        body.playlistId ?? null,
        body.layoutId ?? null,
        body.screenId ?? null,
        body.groupId ?? null,
        body.priority,
        body.daysOfWeek ?? null,
        body.startTime ?? null,
        body.endTime ?? null,
        body.startDate ?? null,
        body.endDate ?? null,
        body.weekInterval,
        body.blackout,
      ],
    );
    audit({ userId: req.principal!.id, companyId, action: 'assignment.create', entityId: rows[0]!.id as string, ip: req.ip });
    notifyCompany(companyId, { type: 'sync' });
    return reply.code(201).send(rows[0]);
  });

  // Edit a slot in place (content and schedule; the target screen/group stays).
  app.patch('/api/assignments/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const body = z
      .object({
        playlistId: z.string().uuid().nullish(),
        layoutId: z.string().uuid().nullish(),
        blackout: z.boolean().default(false),
        priority: z.number().int().min(0).max(1000).default(0),
        daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).nullish(),
        startTime: z.string().regex(timeRe).nullish(),
        endTime: z.string().regex(timeRe).nullish(),
        startDate: z.string().regex(dateRe).nullish(),
        endDate: z.string().regex(dateRe).nullish(),
        weekInterval: z.number().int().min(1).max(8).default(1),
      })
      .refine((b) => Number(!!b.playlistId) + Number(!!b.layoutId) + Number(b.blackout) === 1, {
        message: 'exactly one of playlistId/layoutId/blackout',
      })
      .refine((b) => !!b.startTime === !!b.endTime, {
        message: 'startTime and endTime must be set together',
      })
      .refine((b) => b.weekInterval === 1 || !!b.startDate, {
        message: 'recurrence intervals need a startDate anchor',
      })
      .parse(req.body);

    const { rows } = await query<{ company_id: string }>('SELECT company_id FROM assignments WHERE id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    const companyId = rows[0].company_id;
    if (!canAccessCompany(req.principal!, companyId, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    // New content must belong to this company.
    if (body.playlistId) {
      const { rowCount } = await query('SELECT 1 FROM playlists WHERE id = $1 AND company_id = $2', [body.playlistId, companyId]);
      if (!rowCount) return reply.code(400).send({ error: 'cross_company' });
    }
    if (body.layoutId) {
      const { rowCount } = await query('SELECT 1 FROM layouts WHERE id = $1 AND company_id = $2', [body.layoutId, companyId]);
      if (!rowCount) return reply.code(400).send({ error: 'cross_company' });
    }

    await query(
      `UPDATE assignments SET
         playlist_id = $2, layout_id = $3, blackout = $4, priority = $5, days_of_week = $6,
         start_time = $7, end_time = $8, start_date = $9, end_date = $10, week_interval = $11
       WHERE id = $1`,
      [
        id,
        body.playlistId ?? null,
        body.layoutId ?? null,
        body.blackout,
        body.priority,
        body.daysOfWeek ?? null,
        body.startTime ?? null,
        body.endTime ?? null,
        body.startDate ?? null,
        body.endDate ?? null,
        body.weekInterval,
      ],
    );
    audit({ userId: req.principal!.id, companyId, action: 'assignment.update', entityId: id, ip: req.ip });
    notifyCompany(companyId, { type: 'sync' });
    return reply.send({ ok: true });
  });

  app.delete('/api/assignments/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await query<{ company_id: string }>('SELECT company_id FROM assignments WHERE id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canAccessCompany(req.principal!, rows[0].company_id, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    await query('DELETE FROM assignments WHERE id = $1', [id]);
    audit({ userId: req.principal!.id, companyId: rows[0].company_id, action: 'assignment.delete', entityId: id, ip: req.ip });
    notifyCompany(rows[0].company_id, { type: 'sync' });
    return reply.send({ ok: true });
  });
}
