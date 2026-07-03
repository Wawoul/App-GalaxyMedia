import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { canAccessCompany } from '../lib/permissions.js';
import { requireUser } from '../plugins/auth.js';

export function reportRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', requireUser);

  // Proof-of-play rollup: plays per screen per item per day (UTC days).
  app.get('/api/companies/:companyId/reports/proof-of-play', async (req, reply) => {
    const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
    if (!canAccessCompany(req.principal!, companyId, 'viewer')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const { rows } = await query(
      `SELECT to_char(p.played_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              s.name AS screen_name, p.item_name,
              count(*)::int AS plays,
              max(p.played_at) AS last_played
       FROM proof_of_play p
       JOIN screens s ON s.id = p.screen_id
       WHERE p.company_id = $1 AND p.played_at > now() - make_interval(days => $2)
       GROUP BY day, s.name, p.item_name
       ORDER BY day DESC, s.name, plays DESC`,
      [companyId, days],
    );
    return reply.send(rows);
  });
}
