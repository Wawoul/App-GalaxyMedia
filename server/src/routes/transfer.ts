import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { canAccessCompany } from '../lib/permissions.js';
import { validatePresetZones } from '../lib/presets.js';
import { requireUser } from '../plugins/auth.js';
import { notifyCompany } from '../ws.js';

/**
 * Company config export/import: groups, playlists, layouts, and group-targeted
 * schedule assignments as portable JSON. Media files are NOT included; on
 * import, playlist items are matched to the target company's media by sha256
 * (upload the same files first), and unmatched items are skipped with a count.
 * Screen-targeted assignments are skipped (screens differ per site).
 */

const EXPORT_VERSION = 1;

const importSchema = z.object({
  galaxyMediaExport: z.literal(EXPORT_VERSION),
  groups: z.array(z.object({ name: z.string().min(1).max(200), timezone: z.string().max(64) })).max(200),
  playlists: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        items: z
          .array(
            z.object({
              url: z.string().max(2000).nullish(),
              sha256: z.string().max(64).nullish(),
              originalName: z.string().max(300).nullish(),
              durationMs: z.number().int().nullish(),
              muted: z.boolean().default(false),
              enabled: z.boolean().default(true),
            }),
          )
          .max(500),
      }),
    )
    .max(200),
  layouts: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        preset: z.enum(['main-side', 'main-ticker', 'main-side-ticker', 'split-2', 'custom']),
        zones: z.object({
          main: z.string().nullish(), // playlist NAME references
          side: z.string().nullish(),
          ticker: z.object({ texts: z.array(z.string().max(500)).max(50) }).nullish(),
          custom: z
            .array(
              z.object({
                x: z.number(),
                y: z.number(),
                w: z.number(),
                h: z.number(),
                playlist: z.string().nullish(), // by name
                tickerTexts: z.array(z.string().max(500)).max(50).nullish(),
              }),
            )
            .max(6)
            .nullish(),
        }),
      }),
    )
    .max(100),
  assignments: z
    .array(
      z.object({
        playlist: z.string().nullish(), // by name
        layout: z.string().nullish(),
        blackout: z.boolean().default(false),
        group: z.string().min(1), // by name; group-targeted only
        priority: z.number().int().min(0).max(1000).default(0),
        daysOfWeek: z.array(z.number().int().min(0).max(6)).nullish(),
        startTime: z.string().nullish(),
        endTime: z.string().nullish(),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        weekInterval: z.number().int().min(1).max(8).default(1),
      }),
    )
    .max(500),
});

export function transferRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', requireUser);

  app.get('/api/companies/:companyId/export', async (req, reply) => {
    const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
    if (!canAccessCompany(req.principal!, companyId, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const [company, groups, playlists, items, layouts, assignments] = await Promise.all([
      query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [companyId]),
      query('SELECT name, timezone FROM screen_groups WHERE company_id = $1 ORDER BY name', [companyId]),
      query<{ id: string; name: string }>('SELECT id, name FROM playlists WHERE company_id = $1 ORDER BY name', [companyId]),
      query<{
        playlist_id: string;
        url: string | null;
        duration_ms: number | null;
        muted: boolean;
        enabled: boolean;
        sha256: string | null;
        original_name: string | null;
      }>(
        `SELECT i.playlist_id, i.url, i.duration_ms, i.muted, i.enabled, m.sha256, m.original_name
         FROM playlist_items i
         JOIN playlists p ON p.id = i.playlist_id
         LEFT JOIN media m ON m.id = i.media_id
         WHERE p.company_id = $1 ORDER BY i.playlist_id, i.position`,
        [companyId],
      ),
      query<{
        name: string;
        preset: string;
        zones: {
          main?: string;
          side?: string;
          ticker?: { texts: string[] };
          custom?: { x: number; y: number; w: number; h: number; playlistId?: string | null; tickerTexts?: string[] | null }[];
        };
      }>('SELECT name, preset, zones FROM layouts WHERE company_id = $1 ORDER BY name', [companyId]),
      query<{
        playlist_name: string | null;
        layout_name: string | null;
        blackout: boolean;
        group_name: string | null;
        priority: number;
        days_of_week: number[] | null;
        start_time: string | null;
        end_time: string | null;
        start_date: string | null;
        end_date: string | null;
        week_interval: number;
      }>(
        `SELECT p.name AS playlist_name, l.name AS layout_name, a.blackout, g.name AS group_name,
                a.priority, a.days_of_week, a.start_time, a.end_time, a.week_interval,
                to_char(a.start_date, 'YYYY-MM-DD') AS start_date,
                to_char(a.end_date, 'YYYY-MM-DD') AS end_date
         FROM assignments a
         LEFT JOIN playlists p ON p.id = a.playlist_id
         LEFT JOIN layouts l ON l.id = a.layout_id
         LEFT JOIN screen_groups g ON g.id = a.group_id
         WHERE a.company_id = $1 AND a.group_id IS NOT NULL`,
        [companyId],
      ),
    ]);

    const playlistName = new Map(playlists.rows.map((p) => [p.id, p.name]));
    // Layout zones store playlist ids; export them as names.
    const idToName = (id?: string | null) => (id ? (playlistName.get(id) ?? null) : null);

    const doc = {
      galaxyMediaExport: EXPORT_VERSION,
      exportedFrom: company.rows[0]?.name,
      exportedAt: new Date().toISOString(),
      groups: groups.rows,
      playlists: playlists.rows.map((p) => ({
        name: p.name,
        items: items.rows
          .filter((i) => i.playlist_id === p.id)
          .map((i) => ({
            url: i.url,
            sha256: i.sha256,
            originalName: i.original_name,
            durationMs: i.duration_ms,
            muted: i.muted,
            enabled: i.enabled,
          })),
      })),
      layouts: layouts.rows.map((l) => ({
        name: l.name,
        preset: l.preset,
        zones: {
          main: idToName(l.zones.main),
          side: idToName(l.zones.side),
          ticker: l.zones.ticker ?? null,
          custom:
            l.zones.custom?.map((zone) => ({
              x: zone.x,
              y: zone.y,
              w: zone.w,
              h: zone.h,
              playlist: idToName(zone.playlistId),
              tickerTexts: zone.tickerTexts ?? null,
            })) ?? null,
        },
      })),
      assignments: assignments.rows.map((a) => ({
        playlist: a.playlist_name,
        layout: a.layout_name,
        blackout: a.blackout,
        group: a.group_name!,
        priority: a.priority,
        daysOfWeek: a.days_of_week,
        startTime: a.start_time,
        endTime: a.end_time,
        startDate: a.start_date,
        endDate: a.end_date,
        weekInterval: a.week_interval,
      })),
    };

    audit({ userId: req.principal!.id, companyId, action: 'company.export', ip: req.ip });
    const filename = `galaxy-${(company.rows[0]?.name ?? 'company').replace(/[^\w-]+/g, '_')}.json`;
    return reply
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(doc);
  });

  // Exports can be sizable; allow up to 10 MB of JSON here.
  app.post('/api/companies/:companyId/import', { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
    if (!canAccessCompany(req.principal!, companyId, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const doc = importSchema.parse(req.body);

    const summary = { groups: 0, playlists: 0, layouts: 0, assignments: 0, skippedItems: 0, skippedLayouts: 0 };
    await withTransaction(async (tx) => {
      // Groups: reuse by name, create missing.
      const groupIds = new Map<string, string>();
      const existingGroups = await tx.query<{ id: string; name: string }>(
        'SELECT id, name FROM screen_groups WHERE company_id = $1',
        [companyId],
      );
      for (const g of existingGroups.rows) groupIds.set(g.name, g.id);
      for (const g of doc.groups) {
        if (groupIds.has(g.name)) continue;
        const { rows } = await tx.query<{ id: string }>(
          'INSERT INTO screen_groups (company_id, name, timezone) VALUES ($1, $2, $3) RETURNING id',
          [companyId, g.name, g.timezone],
        );
        groupIds.set(g.name, rows[0]!.id);
        summary.groups++;
      }

      // Media lookup by sha256 in the target company.
      const media = await tx.query<{ id: string; sha256: string }>(
        'SELECT id, sha256 FROM media WHERE company_id = $1',
        [companyId],
      );
      const mediaBySha = new Map(media.rows.map((m) => [m.sha256, m.id]));

      // Playlists (always created fresh; name collisions get a suffix).
      const playlistIds = new Map<string, string>();
      const existingNames = new Set(
        (await tx.query<{ name: string }>('SELECT name FROM playlists WHERE company_id = $1', [companyId])).rows.map(
          (r) => r.name,
        ),
      );
      for (const p of doc.playlists) {
        let name = p.name;
        while (existingNames.has(name)) name = `${name} (imported)`;
        existingNames.add(name);
        const { rows } = await tx.query<{ id: string }>(
          'INSERT INTO playlists (company_id, name) VALUES ($1, $2) RETURNING id',
          [companyId, name],
        );
        const playlistId = rows[0]!.id;
        playlistIds.set(p.name, playlistId);
        summary.playlists++;
        let position = 0;
        for (const item of p.items) {
          const mediaId = item.sha256 ? (mediaBySha.get(item.sha256) ?? null) : null;
          if (!mediaId && !item.url) {
            summary.skippedItems++; // media not present in this company
            continue;
          }
          await tx.query(
            `INSERT INTO playlist_items (playlist_id, position, media_id, url, duration_ms, enabled, muted)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [playlistId, position++, mediaId, mediaId ? null : item.url, item.durationMs ?? null, item.enabled, item.muted],
          );
        }
      }

      // Layouts (zone playlist names resolved against just-imported playlists).
      const layoutIds = new Map<string, string>();
      for (const l of doc.layouts) {
        const main = l.zones.main ? (playlistIds.get(l.zones.main) ?? null) : null;
        const side = l.zones.side ? (playlistIds.get(l.zones.side) ?? null) : null;
        const custom =
          l.zones.custom?.map((zone) => ({
            x: zone.x,
            y: zone.y,
            w: zone.w,
            h: zone.h,
            playlistId: zone.playlist ? (playlistIds.get(zone.playlist) ?? null) : null,
            tickerTexts: zone.tickerTexts ?? null,
          })) ?? null;
        const zones = { main, side, ticker: l.zones.ticker ?? null, custom };
        // A referenced playlist that didn't import (name typo, hand-edited
        // export) would otherwise silently create a layout with an empty
        // required zone - something the direct-create endpoint would reject.
        if (validatePresetZones(l.preset, zones)) {
          summary.skippedLayouts++;
          continue;
        }
        const { rows } = await tx.query<{ id: string }>(
          'INSERT INTO layouts (company_id, name, preset, zones) VALUES ($1, $2, $3, $4) RETURNING id',
          [companyId, l.name, l.preset, JSON.stringify(zones)],
        );
        layoutIds.set(l.name, rows[0]!.id);
        summary.layouts++;
      }

      // Group-targeted assignments.
      for (const a of doc.assignments) {
        const groupId = groupIds.get(a.group);
        const playlistId = a.playlist ? (playlistIds.get(a.playlist) ?? null) : null;
        const layoutId = a.layout ? (layoutIds.get(a.layout) ?? null) : null;
        if (!groupId || (!playlistId && !layoutId && !a.blackout)) continue;
        await tx.query(
          `INSERT INTO assignments
             (company_id, playlist_id, layout_id, blackout, group_id, priority, days_of_week,
              start_time, end_time, start_date, end_date, week_interval)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            companyId,
            playlistId,
            layoutId,
            a.blackout,
            groupId,
            a.priority,
            a.daysOfWeek ?? null,
            a.startTime ?? null,
            a.endTime ?? null,
            a.startDate ?? null,
            a.endDate ?? null,
            a.weekInterval,
          ],
        );
        summary.assignments++;
      }
    });

    audit({ userId: req.principal!.id, companyId, action: 'company.import', ip: req.ip, detail: summary });
    notifyCompany(companyId, { type: 'sync' });
    return reply.send(summary);
  });
}
