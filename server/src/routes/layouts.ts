import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { canAccessCompany } from '../lib/permissions.js';
import { validatePresetZones } from '../lib/presets.js';
import { requireUser } from '../plugins/auth.js';
import { notifyCompany } from '../ws.js';

const zonesSchema = z.object({
  main: z.string().uuid().nullish(),
  side: z.string().uuid().nullish(),
  ticker: z.object({ texts: z.array(z.string().trim().min(1).max(500)).max(50) }).nullish(),
  // Freeform: explicit geometry per zone (fractions of the screen).
  custom: z
    .array(
      z
        .object({
          x: z.number().min(0).max(0.95),
          y: z.number().min(0).max(0.95),
          w: z.number().min(0.05).max(1),
          h: z.number().min(0.05).max(1),
          playlistId: z.string().uuid().nullish(),
          tickerTexts: z.array(z.string().trim().min(1).max(500)).max(50).nullish(),
        })
        .refine((zone) => !!zone.playlistId !== !!zone.tickerTexts?.length, {
          message: 'each zone needs a playlist or ticker text',
        })
        .refine((zone) => zone.x + zone.w <= 1.001 && zone.y + zone.h <= 1.001, {
          message: 'zone extends past the screen edge',
        }),
    )
    .min(1)
    .max(6)
    .nullish(),
});

export function layoutRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', requireUser);

  app.get('/api/companies/:companyId/layouts', async (req, reply) => {
    const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
    if (!canAccessCompany(req.principal!, companyId, 'viewer')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const { rows } = await query(
      'SELECT id, name, preset, zones, created_at FROM layouts WHERE company_id = $1 ORDER BY name',
      [companyId],
    );
    return reply.send(rows);
  });

  app.post('/api/companies/:companyId/layouts', async (req, reply) => {
    const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
    if (!canAccessCompany(req.principal!, companyId, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const body = z
      .object({
        name: z.string().trim().min(1).max(200),
        preset: z.enum(['main-side', 'main-ticker', 'main-side-ticker', 'split-2', 'custom']),
        zones: zonesSchema,
      })
      .refine((b) => b.preset !== 'custom' || (b.zones.custom?.length ?? 0) > 0, {
        message: 'custom layouts need at least one zone',
      })
      .parse(req.body);

    // Every zone playlist must belong to this company.
    const playlistIds = [
      body.zones.main,
      body.zones.side,
      ...(body.zones.custom?.map((zone) => zone.playlistId) ?? []),
    ].filter((id): id is string => !!id);
    if (playlistIds.length > 0) {
      const { rows } = await query<{ id: string }>(
        'SELECT id FROM playlists WHERE id = ANY($1) AND company_id = $2',
        [playlistIds, companyId],
      );
      if (new Set(rows.map((r) => r.id)).size !== new Set(playlistIds).size) {
        return reply.code(400).send({ error: 'playlist_not_in_company' });
      }
    }
    // The preset's zones must be filled in (ticker needs at least one line).
    const zoneError = validatePresetZones(body.preset, body.zones);
    if (zoneError) return reply.code(400).send({ error: zoneError });

    const { rows } = await query(
      `INSERT INTO layouts (company_id, name, preset, zones) VALUES ($1, $2, $3, $4)
       RETURNING id, name, preset, zones, created_at`,
      [companyId, body.name, body.preset, JSON.stringify(body.zones)],
    );
    audit({ userId: req.principal!.id, companyId, action: 'layout.create', entityId: rows[0]!.id as string, ip: req.ip });
    notifyCompany(companyId, { type: 'sync' });
    return reply.code(201).send(rows[0]);
  });

  app.delete('/api/layouts/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await query<{ company_id: string }>('SELECT company_id FROM layouts WHERE id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canAccessCompany(req.principal!, rows[0].company_id, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    await query('DELETE FROM layouts WHERE id = $1', [id]);
    audit({ userId: req.principal!.id, companyId: rows[0].company_id, action: 'layout.delete', entityId: id, ip: req.ip });
    notifyCompany(rows[0].company_id, { type: 'sync' });
    return reply.send({ ok: true });
  });
}
