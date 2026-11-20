import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SIGNED_URL_TTL_S } from '../config.js';
import { query } from '../db/pool.js';
import { signDownload, stableExpiry } from '../lib/crypto.js';
import { referencedMediaIds, type DesignDoc } from '../lib/designDoc.js';
import { verifyLiveSig } from '../lib/liveSlides.js';

/**
 * The data behind a live slide's page (`/live.html`). Public on purpose - a TV's web view cannot log
 * in - but only for someone holding the slide's signed link, and it returns that one slide's
 * contents and short-lived links to the pictures it uses, nothing else. A wrong signature and an
 * unknown slide get the same answer, so the endpoint cannot be used to discover which slides exist.
 */
export function liveRoutes(app: FastifyInstance): void {
  app.get(
    '/api/live/:id',
    // A TV refreshes this every few minutes; many screens can share one office address.
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { s } = z.object({ s: z.string().min(1).max(64) }).parse(req.query);
      // The web player embeds the page in a sandboxed frame whose origin is "null": allow it to read this.
      reply.header('access-control-allow-origin', '*').header('cache-control', 'no-store');
      if (!verifyLiveSig(id, s)) return reply.code(404).send({ error: 'not_found' });

      const { rows } = await query<{ name: string; width: number; height: number; version: number; document: DesignDoc; company_id: string }>(
        'SELECT name, width, height, version, document, company_id FROM designs WHERE id = $1 AND is_template = false',
        [id],
      );
      const design = rows[0];
      if (!design) return reply.code(404).send({ error: 'not_found' });

      const { preview: _preview, ...document } = design.document;
      const wanted = referencedMediaIds(design.document);
      const owned = wanted.length
        ? (await query<{ id: string }>('SELECT id FROM media WHERE company_id = $1 AND id = ANY($2::uuid[])', [design.company_id, wanted])).rows
        : [];
      const expires = stableExpiry(SIGNED_URL_TTL_S);
      const media = Object.fromEntries(
        owned.map((m) => [m.id, `/api/media/${m.id}/file?token=${signDownload(m.id, 'live', expires)}`]),
      );
      return reply.send({ name: design.name, width: design.width, height: design.height, version: design.version, document, media });
    },
  );
}
