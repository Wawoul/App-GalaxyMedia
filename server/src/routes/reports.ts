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
      // Bucket in the SCREEN's timezone, not UTC. Dayparting resolves on the
      // screen's own clock, so a UTC bucket put an 08:00 play on an Australian
      // screen into the previous calendar day - "yesterday's plays" was then
      // wrong by a day for anything east of UTC.
      // Same fallback chain as lib/effectiveTimezone.ts: own zone, else the first group
      // by name, else London.
      `SELECT to_char(p.played_at AT TIME ZONE coalesce(
                s.timezone,
                (SELECT g.timezone FROM screen_group_members m JOIN screen_groups g ON g.id = m.group_id
                 WHERE m.screen_id = s.id AND g.timezone IS NOT NULL ORDER BY g.name LIMIT 1),
                'Europe/London'), 'YYYY-MM-DD') AS day,
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
