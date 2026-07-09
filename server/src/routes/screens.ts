import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SIGNED_URL_TTL_S } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { signDownload, verifyDownload } from '../lib/crypto.js';
import { canAccessCompany, visibleCompanies } from '../lib/permissions.js';
import { requireUser } from '../plugins/auth.js';
import { signDeviceToken } from '../lib/tokens.js';
import { getApkRelease } from './system.js';
import { notifyScreen } from '../ws.js';

/**
 * Latest support screenshot. Registered OUTSIDE screenRoutes' requireUser scope:
 * the browser loads this in an <img>, which cannot send an Authorization header,
 * so auth is the signed expiring token in the query string (like media files).
 */
export function screenshotRoute(app: FastifyInstance): void {
  app.get('/api/screens/:id/screenshot', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { token } = z.object({ token: z.string() }).parse(req.query);
    if (!verifyDownload(`shot-${id}`, token)) return reply.code(401).send({ error: 'invalid_token' });
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'no-store')
      .sendFile(`screenshots/${id}.jpg`);
  });
}

export function screenRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', requireUser);

  // ── Screen groups ─────────────────────────────────────────────────────────

  app.get('/api/companies/:companyId/groups', async (req, reply) => {
    const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
    if (!canAccessCompany(req.principal!, companyId, 'viewer')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const { rows } = await query(
      `SELECT g.*, (SELECT count(*) FROM screen_group_members m WHERE m.group_id = g.id)::int AS screen_count
       FROM screen_groups g WHERE g.company_id = $1 ORDER BY g.name`,
      [companyId],
    );
    return reply.send(rows);
  });

  app.post('/api/companies/:companyId/groups', async (req, reply) => {
    const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
    if (!canAccessCompany(req.principal!, companyId, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const body = z
      .object({ name: z.string().trim().min(1).max(200), timezone: z.string().max(64).optional() })
      .parse(req.body);
    const { rows } = await query(
      `INSERT INTO screen_groups (company_id, name, timezone)
       VALUES ($1, $2, coalesce($3, 'Europe/London')) RETURNING *`,
      [companyId, body.name, body.timezone ?? null],
    );
    audit({ userId: req.principal!.id, companyId, action: 'group.create', entityId: rows[0]!.id as string, ip: req.ip });
    return reply.code(201).send(rows[0]);
  });

  app.delete('/api/groups/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await query<{ company_id: string }>('SELECT company_id FROM screen_groups WHERE id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canAccessCompany(req.principal!, rows[0].company_id, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    await query('DELETE FROM screen_groups WHERE id = $1', [id]);
    audit({ userId: req.principal!.id, companyId: rows[0].company_id, action: 'group.delete', entityId: id, ip: req.ip });
    return reply.send({ ok: true });
  });

  // ── Screens ───────────────────────────────────────────────────────────────

  app.get('/api/screens', async (req, reply) => {
    const q = z.object({ companyId: z.string().uuid().optional() }).parse(req.query);
    const visible = visibleCompanies(req.principal!);
    if (q.companyId && !canAccessCompany(req.principal!, q.companyId, 'viewer')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const companyFilter = q.companyId ? [q.companyId] : visible === 'all' ? null : visible;
    // Older player builds report the media UUID as current_item - translate it
    // to the media's name server-side so the dashboard is always readable.
    const { rows } = await query(
      `SELECT s.id, s.company_id, s.name, s.timezone, s.paired_at, s.last_seen_at, s.app_version,
              s.ip, coalesce(med.original_name, s.current_item) AS current_item,
              s.storage_free_mb, s.battery_pct, s.ram_free_mb, s.ram_total_mb,
              s.cpu_pct, s.wifi_rssi, s.uptime_s::int AS uptime_s, s.orientation,
              s.last_crash_at, s.last_crash_message,
              s.screenshot_at, s.created_at,
              c.name AS company_name,
              (s.device_token_jti IS NOT NULL) AS paired,
              (s.last_seen_at > now() - interval '3 minutes') AS online,
              coalesce(array_agg(m.group_id) FILTER (WHERE m.group_id IS NOT NULL), '{}') AS group_ids,
              pl.name AS playlist_name
       FROM screens s
       JOIN companies c ON c.id = s.company_id
       LEFT JOIN screen_group_members m ON m.screen_id = s.id
       LEFT JOIN media med ON med.company_id = s.company_id AND med.id::text = s.current_item
       LEFT JOIN LATERAL (
         -- Effective assignment, same rule the TV uses: direct beats group, newest wins.
         SELECT coalesce(p.name, l.name, 'Black Screen') AS name
         FROM assignments a
         LEFT JOIN playlists p ON p.id = a.playlist_id
         LEFT JOIN layouts l ON l.id = a.layout_id
         WHERE a.company_id = s.company_id AND (
           a.screen_id = s.id
           OR a.group_id IN (SELECT group_id FROM screen_group_members gm WHERE gm.screen_id = s.id)
         )
         ORDER BY (a.screen_id IS NOT NULL) DESC, a.created_at DESC
         LIMIT 1
       ) pl ON true
       WHERE ($1::uuid[] IS NULL OR s.company_id = ANY($1))
       GROUP BY s.id, c.name, med.original_name, pl.name
       ORDER BY c.name, s.name`,
      [companyFilter],
    );
    const expires = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S;
    return reply.send(
      rows.map((s) => ({
        ...s,
        screenshot_url: s.screenshot_at
          ? `/api/screens/${s.id}/screenshot?token=${signDownload(`shot-${s.id}`, req.principal!.id, expires)}`
          : null,
      })),
    );
  });

  // Claim a pairing code → create the screen and hand the device its token.
  app.post('/api/screens/pair', async (req, reply) => {
    const body = z
      .object({
        code: z.string().trim().toUpperCase().length(6),
        companyId: z.string().uuid(),
        name: z.string().trim().min(1).max(200),
        groupIds: z.array(z.string().uuid()).default([]),
      })
      .parse(req.body);
    if (!canAccessCompany(req.principal!, body.companyId, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const screen = await withTransaction(async (tx) => {
      const pending = await tx.query<{ id: string }>(
        `SELECT id FROM pairing_requests
         WHERE code = $1 AND screen_id IS NULL AND expires_at > now() FOR UPDATE`,
        [body.code],
      );
      if (!pending.rows[0]) return null;

      // Groups must belong to the same company - reject cross-tenant grouping.
      if (body.groupIds.length > 0) {
        const owned = await tx.query<{ id: string }>(
          'SELECT id FROM screen_groups WHERE id = ANY($1) AND company_id = $2',
          [body.groupIds, body.companyId],
        );
        if (owned.rows.length !== body.groupIds.length) {
          throw Object.assign(new Error('group_not_in_company'), { statusCode: 400 });
        }
      }

      const jti = randomUUID();
      const created = await tx.query<{ id: string }>(
        `INSERT INTO screens (company_id, name, device_token_jti, paired_at)
         VALUES ($1, $2, $3, now()) RETURNING id`,
        [body.companyId, body.name, jti],
      );
      const screenId = created.rows[0]!.id;
      for (const groupId of body.groupIds) {
        await tx.query('INSERT INTO screen_group_members (screen_id, group_id) VALUES ($1, $2)', [
          screenId,
          groupId,
        ]);
      }
      // Park the token on the pairing request; the device's next poll collects it.
      await tx.query('UPDATE pairing_requests SET screen_id = $2, device_token = $3 WHERE id = $1', [
        pending.rows[0].id,
        screenId,
        signDeviceToken(screenId, jti),
      ]);
      return { id: screenId };
    });

    if (!screen) return reply.code(404).send({ error: 'code_not_found_or_expired' });
    audit({
      userId: req.principal!.id,
      companyId: body.companyId,
      action: 'screen.pair',
      entityId: screen.id,
      ip: req.ip,
    });
    return reply.code(201).send({ id: screen.id });
  });

  app.patch('/api/screens/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        timezone: z.string().max(64).nullable().optional(),
        orientation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
        groupIds: z.array(z.string().uuid()).optional(),
      })
      .parse(req.body);
    const { rows } = await query<{ company_id: string }>('SELECT company_id FROM screens WHERE id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    const companyId = rows[0].company_id;
    if (!canAccessCompany(req.principal!, companyId, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    await withTransaction(async (tx) => {
      if (body.name !== undefined) await tx.query('UPDATE screens SET name = $2 WHERE id = $1', [id, body.name]);
      if (body.timezone !== undefined) {
        await tx.query('UPDATE screens SET timezone = $2 WHERE id = $1', [id, body.timezone]);
      }
      if (body.orientation !== undefined) {
        await tx.query('UPDATE screens SET orientation = $2 WHERE id = $1', [id, body.orientation]);
      }
      if (body.groupIds !== undefined) {
        const owned = await tx.query<{ id: string }>(
          'SELECT id FROM screen_groups WHERE id = ANY($1) AND company_id = $2',
          [body.groupIds, companyId],
        );
        if (owned.rows.length !== body.groupIds.length) {
          throw Object.assign(new Error('group_not_in_company'), { statusCode: 400 });
        }
        await tx.query('DELETE FROM screen_group_members WHERE screen_id = $1', [id]);
        for (const groupId of body.groupIds) {
          await tx.query('INSERT INTO screen_group_members (screen_id, group_id) VALUES ($1, $2)', [id, groupId]);
        }
      }
    });
    notifyScreen(id, { type: 'sync' });
    audit({ userId: req.principal!.id, companyId, action: 'screen.update', entityId: id, ip: req.ip });
    return reply.send({ ok: true });
  });

  // Move a screen to another company. Group memberships and direct assignments
  // are dropped (they belong to the old company); the paired TV stays paired and
  // simply syncs the new company's content.
  app.post('/api/screens/:id/move', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ companyId: z.string().uuid() }).parse(req.body);
    const { rows } = await query<{ company_id: string }>('SELECT company_id FROM screens WHERE id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    const from = rows[0].company_id;
    if (from === body.companyId) return reply.send({ ok: true });
    // Needs admin on the source and at least editor on the destination.
    if (
      !canAccessCompany(req.principal!, from, 'admin') ||
      !canAccessCompany(req.principal!, body.companyId, 'editor')
    ) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    await withTransaction(async (tx) => {
      await tx.query('DELETE FROM screen_group_members WHERE screen_id = $1', [id]);
      await tx.query('DELETE FROM assignments WHERE screen_id = $1', [id]);
      await tx.query('UPDATE screens SET company_id = $2 WHERE id = $1', [id, body.companyId]);
    });
    notifyScreen(id, { type: 'sync' });
    audit({
      userId: req.principal!.id,
      companyId: body.companyId,
      action: 'screen.move',
      entityId: id,
      ip: req.ip,
      detail: { from, to: body.companyId },
    });
    return reply.send({ ok: true });
  });

  // Unpair: revoke the device token; TV returns to the pairing screen.
  app.post('/api/screens/:id/unpair', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await query<{ company_id: string }>('SELECT company_id FROM screens WHERE id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canAccessCompany(req.principal!, rows[0].company_id, 'admin')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    notifyScreen(id, { type: 'unpair' });
    await query('UPDATE screens SET device_token_jti = NULL WHERE id = $1', [id]);
    audit({ userId: req.principal!.id, companyId: rows[0].company_id, action: 'screen.unpair', entityId: id, ip: req.ip });
    return reply.send({ ok: true });
  });

  app.delete('/api/screens/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await query<{ company_id: string }>('SELECT company_id FROM screens WHERE id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canAccessCompany(req.principal!, rows[0].company_id, 'admin')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    notifyScreen(id, { type: 'unpair' });
    await query('DELETE FROM screens WHERE id = $1', [id]);
    audit({ userId: req.principal!.id, companyId: rows[0].company_id, action: 'screen.delete', entityId: id, ip: req.ip });
    return reply.send({ ok: true });
  });

  // Remote commands: reload | identify | restart | clear_cache | screenshot | update
  // "update" is deliberate and separate from "reload": installing shows a system
  // confirm prompt on the TV that pauses playback until someone is on-site to tap
  // it, so it must only ever be sent when a tech explicitly asks for it.
  app.post('/api/screens/:id/command', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ command: z.enum(['reload', 'identify', 'restart', 'clear_cache', 'screenshot', 'update']) })
      .parse(req.body);
    const { rows } = await query<{ company_id: string }>('SELECT company_id FROM screens WHERE id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canAccessCompany(req.principal!, rows[0].company_id, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    // Sending "update" with nothing published would report delivered:true while
    // the TV silently finds no release - reject up front instead.
    if (body.command === 'update' && !(await getApkRelease())) {
      return reply.code(400).send({ error: 'no_release_published' });
    }
    const delivered = notifyScreen(id, { type: 'command', command: body.command });
    audit({
      userId: req.principal!.id,
      companyId: rows[0].company_id,
      action: `screen.command.${body.command}`,
      entityId: id,
      ip: req.ip,
    });
    return reply.send({ ok: true, delivered });
  });
}
