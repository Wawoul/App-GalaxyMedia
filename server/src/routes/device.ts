import type { FastifyInstance } from 'fastify';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config, PAIRING_CODE_TTL_S, SIGNED_URL_TTL_S } from '../config.js';
import { query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { generatePairingCode, signDownload } from '../lib/crypto.js';
import { LAYOUT_PRESETS } from '../lib/presets.js';
import { nowInTimezone, resolveActive, type ScheduleEntry } from '../lib/schedule.js';
import { verifyToken } from '../lib/tokens.js';
import { requireDevice } from '../plugins/auth.js';
import { notifyRecovery } from '../alerts.js';
import { apkInfoForDevice } from './system.js';
import { registerSocket } from '../ws.js';

export function deviceRoutes(app: FastifyInstance): void {
  // ── Pairing (unauthenticated - aggressively rate-limited, SPEC §8) ────────

  app.register(async (scope) => {
    scope.addHook('onRequest', scope.rateLimit({ max: 12, timeWindow: '1 minute' }));

    // Fresh device asks for a pairing code to display.
    scope.post('/api/device/register', async (req, reply) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generatePairingCode();
        try {
          const { rows } = await query<{ id: string; code: string }>(
            `INSERT INTO pairing_requests (code, expires_at)
             VALUES ($1, now() + make_interval(secs => $2)) RETURNING id, code`,
            [code, PAIRING_CODE_TTL_S],
          );
          audit({ action: 'device.register', ip: req.ip });
          return reply.code(201).send({
            requestId: rows[0]!.id,
            code: rows[0]!.code,
            expiresInS: PAIRING_CODE_TTL_S,
            pollIntervalS: 5,
          });
        } catch {
          // active-code collision - retry with a new code
        }
      }
      return reply.code(503).send({ error: 'code_generation_failed' });
    });

    // Device polls until an admin claims its code; token is delivered exactly once.
    scope.get('/api/device/register/:requestId', async (req, reply) => {
      const { requestId } = z.object({ requestId: z.string().uuid() }).parse(req.params);
      const { rows } = await query<{
        code: string;
        expires_at: Date;
        screen_id: string | null;
        device_token: string | null;
      }>('SELECT code, expires_at, screen_id, device_token FROM pairing_requests WHERE id = $1', [requestId]);
      const pr = rows[0];
      if (!pr) return reply.code(404).send({ error: 'not_found' });

      if (pr.screen_id && pr.device_token) {
        // Deliberately NOT single-shot: if the response carrying the token is
        // lost (flaky TV wifi, proxy timeout), the device's retry must still
        // succeed or it's stuck un-pairable. The token stays retrievable until
        // the request's own expiry (short); only this request's secret UUID can
        // fetch it, and it's wiped on the first poll after expiry.
        if (pr.expires_at < new Date()) {
          await query('UPDATE pairing_requests SET device_token = NULL WHERE id = $1', [requestId]);
          return reply.code(410).send({ error: 'expired' });
        }
        return reply.send({ status: 'paired', screenId: pr.screen_id, deviceToken: pr.device_token });
      }
      if (pr.screen_id) return reply.code(410).send({ error: 'token_already_delivered' });
      if (pr.expires_at < new Date()) return reply.code(410).send({ error: 'expired' });
      return reply.send({ status: 'waiting', code: pr.code });
    });
  });

  // ── Authenticated device endpoints ────────────────────────────────────────

  app.register(async (scope) => {
    scope.addHook('preHandler', requireDevice);

    /**
     * Sync manifest: everything the screen needs to play, with signed media URLs.
     * Assignment resolution (SPEC §2): direct-to-screen beats group; newest wins.
     */
    scope.get('/api/device/manifest', async (req, reply) => {
      const screenId = req.screenId!;
      const { rows: screenRows } = await query<{
        id: string;
        name: string;
        company_id: string;
        timezone: string | null;
        orientation: number;
        brand_name: string;
      }>(
        `SELECT s.id, s.name, s.company_id, s.timezone, s.orientation, c.brand_name
         FROM screens s JOIN companies c ON c.id = s.company_id WHERE s.id = $1`,
        [screenId],
      );
      const screen = screenRows[0]!;
      const timezone = screen.timezone ?? 'Europe/London';

      // Every assignment relevant to this screen (SPEC §6: the TV stores the
      // whole schedule and dayparts locally, so offline behavior matches online).
      const { rows: assignments } = await query<{
        id: string;
        playlist_id: string | null;
        layout_id: string | null;
        blackout: boolean;
        screen_id: string | null;
        created_at: Date;
        priority: number;
        days_of_week: number[] | null;
        start_time: string | null;
        end_time: string | null;
        start_date: string | null;
        end_date: string | null;
        week_interval: number;
      }>(
        `SELECT a.id, a.playlist_id, a.layout_id, a.blackout, a.screen_id, a.created_at, a.priority,
                a.days_of_week, a.start_time, a.end_time, a.week_interval,
                to_char(a.start_date, 'YYYY-MM-DD') AS start_date,
                to_char(a.end_date, 'YYYY-MM-DD') AS end_date
         FROM assignments a
         WHERE a.company_id = $2 AND (
           a.screen_id = $1
           OR a.group_id IN (SELECT group_id FROM screen_group_members WHERE screen_id = $1)
         )`,
        [screenId, screen.company_id],
      );

      // Referenced layouts: their zone playlists also need loading.
      const layoutIds = [...new Set(assignments.flatMap((a) => (a.layout_id ? [a.layout_id] : [])))];
      interface CustomZone {
        x: number;
        y: number;
        w: number;
        h: number;
        playlistId?: string | null;
        tickerTexts?: string[] | null;
      }
      const layoutRows =
        layoutIds.length > 0
          ? (
              await query<{
                id: string;
                name: string;
                preset: string;
                zones: {
                  main?: string | null;
                  side?: string | null;
                  ticker?: { texts: string[] } | null;
                  custom?: CustomZone[] | null;
                };
              }>('SELECT id, name, preset, zones FROM layouts WHERE id = ANY($1)', [layoutIds])
            ).rows
          : [];

      // Load each referenced playlist once, with signed media URLs.
      const expires = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S;
      const playlistIds = [
        ...new Set([
          ...assignments.flatMap((a) => (a.playlist_id ? [a.playlist_id] : [])),
          ...layoutRows.flatMap((l) =>
            [
              l.zones.main,
              l.zones.side,
              ...(l.zones.custom?.map((zone) => zone.playlistId) ?? []),
            ].filter((id): id is string => !!id),
          ),
        ]),
      ];
      const playlists = new Map<string, unknown>();
      for (const playlistId of playlistIds) {
        const { rows: items } = await query<{
          id: string;
          media_id: string | null;
          url: string | null;
          duration_ms: number | null;
          muted: boolean;
          kind: string | null;
          mime: string | null;
          sha256: string | null;
          size_bytes: string | null;
          original_name: string | null;
        }>(
          `SELECT i.id, i.media_id, i.url, i.duration_ms, i.muted,
                  m.kind, m.mime, m.sha256, m.size_bytes, m.original_name
           FROM playlist_items i LEFT JOIN media m ON m.id = i.media_id
           WHERE i.playlist_id = $1 AND i.enabled ORDER BY i.position`,
          [playlistId],
        );
        playlists.set(playlistId, {
          id: playlistId,
          items: items.map((i) => ({
            id: i.id,
            type: i.media_id ? i.kind : 'url',
            name: i.original_name ?? i.url,
            url: i.media_id
              ? `${config.BASE_URL}/api/media/${i.media_id}/file?token=${signDownload(i.media_id, screenId, expires)}`
              : i.url,
            mediaId: i.media_id,
            sha256: i.sha256,
            sizeBytes: i.size_bytes ? Number(i.size_bytes) : null,
            mime: i.mime,
            durationMs: i.duration_ms,
            muted: i.muted,
          })),
        });
      }

      // Layouts resolved to concrete zones: geometry + playlist / ticker text.
      const layouts = new Map<string, unknown>();
      for (const layout of layoutRows) {
        const zones =
          layout.preset === 'custom'
            ? (layout.zones.custom ?? []).map((zone, index) => ({
                // First content zone is "main" so the dashboard's now-playing works.
                key: zone.tickerTexts?.length ? `ticker${index}` : index === 0 ? 'main' : `z${index}`,
                x: zone.x,
                y: zone.y,
                w: zone.w,
                h: zone.h,
                playlist: zone.playlistId ? (playlists.get(zone.playlistId) ?? null) : null,
                tickerTexts: zone.tickerTexts ?? null,
              }))
            : (LAYOUT_PRESETS[layout.preset] ?? []).map((zone) => ({
                key: zone.key,
                x: zone.x,
                y: zone.y,
                w: zone.w,
                h: zone.h,
                playlist:
                  zone.key !== 'ticker' && layout.zones[zone.key]
                    ? (playlists.get(layout.zones[zone.key]!) ?? null)
                    : null,
                tickerTexts: zone.key === 'ticker' ? (layout.zones.ticker?.texts ?? []) : null,
              }));
        layouts.set(layout.id, { id: layout.id, name: layout.name, preset: layout.preset, zones });
      }

      const entries: (ScheduleEntry & { layoutId: string | null })[] = assignments.map((a) => ({
        id: a.id,
        playlistId: a.playlist_id,
        layoutId: a.layout_id,
        blackout: a.blackout,
        isDirect: a.screen_id !== null,
        createdAt: a.created_at.toISOString(),
        priority: a.priority,
        daysOfWeek: a.days_of_week,
        startTime: a.start_time,
        endTime: a.end_time,
        startDate: a.start_date,
        endDate: a.end_date,
        weekInterval: a.week_interval,
      }));

      const schedules = entries.map((e) => ({
        ...e,
        playlist: e.playlistId ? playlists.get(e.playlistId) : null,
        layout: e.layoutId ? layouts.get(e.layoutId) : null,
      }));

      // Legacy field for pre-scheduling player builds: the active playlist now
      // (a layout degrades to its main-zone playlist on old builds).
      const active = resolveActive(entries, nowInTimezone(timezone));
      const activeLayout = active?.layoutId ? layoutRows.find((l) => l.id === active.layoutId) : null;
      const legacyPlaylistId =
        active?.playlistId ??
        activeLayout?.zones.main ??
        activeLayout?.zones.custom?.find((zone) => zone.playlistId)?.playlistId ??
        null;

      return reply.send({
        screen: {
          id: screen.id,
          name: screen.name,
          timezone,
          orientation: screen.orientation,
          brandName: screen.brand_name,
        },
        schedules,
        playlist: legacyPlaylistId ? playlists.get(legacyPlaylistId) : null,
        generatedAt: new Date().toISOString(),
      });
    });

    // Support screenshot upload (raw JPEG body, requested via the "screenshot" command).
    scope.post('/api/device/screenshot', { bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length < 100) return reply.code(400).send({ error: 'no_image' });
      // JPEG magic bytes only; anything else is rejected.
      if (!(body[0] === 0xff && body[1] === 0xd8)) return reply.code(415).send({ error: 'not_jpeg' });
      const dir = path.join(config.MEDIA_DIR, 'screenshots');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${req.screenId}.jpg`), body, { mode: 0o640 });
      await query('UPDATE screens SET screenshot_at = now() WHERE id = $1', [req.screenId]);
      return reply.send({ ok: true });
    });

    // Self-update check: current release metadata + signed download URL.
    scope.get('/api/device/apk-info', async (req, reply) => {
      const expires = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S;
      return reply.send(await apkInfoForDevice(req.screenId!, expires));
    });

    scope.post('/api/device/heartbeat', async (req, reply) => {
      const body = z
        .object({
          appVersion: z.string().max(50).optional(),
          currentItem: z.string().max(200).nullish(),
          storageFreeMb: z.number().int().nonnegative().optional(),
          // Device telemetry - all optional so old player builds keep working.
          batteryPct: z.number().int().min(0).max(100).nullish(),
          ramFreeMb: z.number().int().nonnegative().nullish(),
          ramTotalMb: z.number().int().nonnegative().nullish(),
          cpuPct: z.number().int().min(0).max(100).nullish(),
          wifiRssi: z.number().int().min(-127).max(0).nullish(),
          uptimeS: z.number().int().nonnegative().nullish(),
          // Proof-of-play batch: items shown since the last successful heartbeat.
          plays: z
            .array(z.object({ name: z.string().min(1).max(300), at: z.string().datetime() }))
            .max(500)
            .default([]),
          // Last uncaught exception since the previous confirmed report, if any.
          lastCrashAt: z.string().datetime().nullish(),
          lastCrashMessage: z.string().max(500).nullish(),
        })
        .parse(req.body ?? {});
      await query(
        `UPDATE screens SET last_seen_at = now(), app_version = coalesce($2, app_version),
           ip = $3, current_item = $4, storage_free_mb = coalesce($5, storage_free_mb),
           battery_pct = coalesce($6, battery_pct), ram_free_mb = coalesce($7, ram_free_mb),
           ram_total_mb = coalesce($8, ram_total_mb), cpu_pct = coalesce($9, cpu_pct),
           wifi_rssi = coalesce($10, wifi_rssi), uptime_s = coalesce($11, uptime_s),
           last_crash_at = coalesce($12, last_crash_at),
           last_crash_message = coalesce($13, last_crash_message)
         WHERE id = $1`,
        [
          req.screenId,
          body.appVersion ?? null,
          req.ip,
          body.currentItem ?? null,
          body.storageFreeMb ?? null,
          body.batteryPct ?? null,
          body.ramFreeMb ?? null,
          body.ramTotalMb ?? null,
          body.cpuPct ?? null,
          body.wifiRssi ?? null,
          body.uptimeS ?? null,
          body.lastCrashAt ?? null,
          body.lastCrashMessage ?? null,
        ],
      );
      if (body.plays.length > 0) {
        await query(
          `INSERT INTO proof_of_play (company_id, screen_id, item_name, played_at)
           SELECT s.company_id, s.id, p.name, p.at::timestamptz
           FROM screens s, jsonb_to_recordset($2::jsonb) AS p(name text, at text)
           WHERE s.id = $1
           ON CONFLICT (screen_id, item_name, played_at) DO NOTHING`,
          [req.screenId, JSON.stringify(body.plays)],
        );
      }
      notifyRecovery(req.screenId!); // no-op unless an offline alert was sent
      return reply.send({ ok: true });
    });
  });

  // ── WebSocket for instant push (token via query param; WS can't set headers) ──

  app.get('/api/device/ws', { websocket: true }, async (socket, req) => {
    const { token } = z.object({ token: z.string() }).parse(req.query);
    const claims = verifyToken(token);
    if (!claims || claims.typ !== 'device') {
      socket.close(4001, 'unauthenticated');
      return;
    }
    const { rows } = await query<{ id: string }>(
      'SELECT id FROM screens WHERE id = $1 AND device_token_jti = $2',
      [claims.sub, claims.jti],
    );
    if (!rows[0]) {
      socket.close(4001, 'revoked');
      return;
    }
    registerSocket(claims.sub, socket);
  });
}
