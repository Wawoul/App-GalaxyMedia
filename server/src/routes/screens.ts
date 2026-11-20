import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config, SIGNED_URL_TTL_S } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { signDownload, stableExpiry, verifyDownload } from '../lib/crypto.js';
import { removeScreenshot } from '../lib/files.js';
import { timezoneSchema } from '../lib/validators.js';
import { effectiveTimezone } from '../lib/effectiveTimezone.js';
import { nowInTimezone, resolveActive, type ScheduleEntry } from '../lib/schedule.js';
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

/** What each listed screen is playing right now, by screen id (name of playlist/layout). */
async function resolveNowPlaying(
  screens: Record<string, unknown>[],
  companyIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (screens.length === 0) return result;
  const [{ rows: assignments }, { rows: groups }] = await Promise.all([
    query<{
      id: string; company_id: string; screen_id: string | null; group_id: string | null;
      created_at: Date; priority: number; days_of_week: number[] | null;
      start_time: string | null; end_time: string | null; start_date: string | null;
      end_date: string | null; week_interval: number; name: string;
    }>(
      `SELECT a.id, a.company_id, a.screen_id, a.group_id, a.created_at, a.priority,
              a.days_of_week, a.start_time, a.end_time, a.week_interval,
              to_char(a.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(a.end_date, 'YYYY-MM-DD') AS end_date,
              coalesce(p.name, l.name, 'Black Screen') AS name
       FROM assignments a
       LEFT JOIN playlists p ON p.id = a.playlist_id
       LEFT JOIN layouts l ON l.id = a.layout_id
       WHERE a.company_id = ANY($1)`,
      [companyIds],
    ),
    query<{ id: string; name: string; timezone: string | null }>(
      'SELECT id, name, timezone FROM screen_groups WHERE company_id = ANY($1)',
      [companyIds],
    ),
  ]);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const clocks = new Map<string, ReturnType<typeof nowInTimezone>>();
  for (const s of screens) {
    const screenId = s.id as string;
    const groupIds = (s.group_ids as string[]) ?? [];
    const tz = effectiveTimezone(
      s.timezone as string | null,
      groupIds.flatMap((id) => (groupById.has(id) ? [groupById.get(id)!] : [])),
    );
    let now = clocks.get(tz);
    if (!now) clocks.set(tz, (now = nowInTimezone(tz)));
    const entries: (ScheduleEntry & { label: string })[] = assignments
      .filter((a) => a.company_id === s.company_id && (a.screen_id === screenId || (a.group_id !== null && groupIds.includes(a.group_id))))
      .map((a) => ({
        id: a.id,
        playlistId: null,
        isDirect: a.screen_id !== null,
        createdAt: a.created_at.toISOString(),
        priority: a.priority,
        daysOfWeek: a.days_of_week,
        startTime: a.start_time,
        endTime: a.end_time,
        startDate: a.start_date,
        endDate: a.end_date,
        weekInterval: a.week_interval,
        label: a.name,
      }));
    const active = resolveActive(entries, now);
    if (active) result.set(screenId, active.label);
  }
  return result;
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
      .object({ name: z.string().trim().min(1).max(200), timezone: timezoneSchema.optional() })
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
              s.last_crash_at, s.last_crash_message, s.local_ip, s.media_error,
              s.screenshot_at, s.created_at,
              c.name AS company_name,
              (s.device_token_jti IS NOT NULL) AS paired,
              (s.last_seen_at > now() - interval '3 minutes') AS online,
              coalesce(array_agg(m.group_id) FILTER (WHERE m.group_id IS NOT NULL), '{}') AS group_ids,
              NULL::text AS playlist_name
       FROM screens s
       JOIN companies c ON c.id = s.company_id
       LEFT JOIN screen_group_members m ON m.screen_id = s.id
       LEFT JOIN media med ON med.company_id = s.company_id AND med.id::text = s.current_item
       WHERE ($1::uuid[] IS NULL OR s.company_id = ANY($1))
       GROUP BY s.id, c.name, med.original_name
       ORDER BY c.name, s.name`,
      [companyFilter],
    );
    // "Now playing" comes from the SAME resolver the TVs use (lib/schedule.ts), in the
    // same effective timezone. It used to be a SQL copy of the rules that ignored
    // bi-weekly slots, overnight tails and group timezones, so it could disagree.
    const companyIds = [...new Set(rows.map((s) => s.company_id as string))];
    const nowByScreen = await resolveNowPlaying(rows, companyIds);
    const expires = stableExpiry(SIGNED_URL_TTL_S);
    // The release the server currently offers, so the dashboard can flag TVs running older builds.
    const latestAppVersion = (await getApkRelease())?.versionName ?? null;
    return reply.send(
      rows.map((s) => ({
        ...s,
        latest_app_version: latestAppVersion,
        playlist_name: nowByScreen.get(s.id as string) ?? null,
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
        timezone: timezoneSchema.nullable().optional(),
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
      // proof_of_play carries its own company_id, so history left behind would
      // keep showing in the OLD company's reports - and because those reports
      // join screens for the name, they'd render the new tenant's screen name
      // too. Delete it: the play history belongs to the company whose content
      // was playing, and that company no longer owns this screen.
      await tx.query('DELETE FROM proof_of_play WHERE screen_id = $1', [id]);
      // Clear the screenshot pointer as well; the image on disk is of the
      // previous company's content and the new owner can fetch it immediately.
      await tx.query(
        'UPDATE screens SET company_id = $2, screenshot_at = NULL, current_item = NULL WHERE id = $1',
        [id, body.companyId],
      );
    });
    // Best-effort: the DB no longer references it, so a failure here only leaves
    // an orphaned file, never an accessible one.
    await unlink(path.join(config.MEDIA_DIR, 'screenshots', `${id}.jpg`)).catch(() => {});
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
    await removeScreenshot(id); // the file is not covered by the row's cascade
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
