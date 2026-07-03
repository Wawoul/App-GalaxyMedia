import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { canAccessCompany, isMspAdmin, visibleCompanies } from '../lib/permissions.js';
import { requireUser } from '../plugins/auth.js';

export function companyRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', requireUser);

  app.get('/api/companies', async (req, reply) => {
    const visible = visibleCompanies(req.principal!);
    const { rows } =
      visible === 'all'
        ? await query(
            `SELECT c.*, (SELECT count(*) FROM screens s WHERE s.company_id = c.id)::int AS screen_count
             FROM companies c ORDER BY c.name`,
          )
        : await query(
            `SELECT c.*, (SELECT count(*) FROM screens s WHERE s.company_id = c.id)::int AS screen_count
             FROM companies c WHERE c.id = ANY($1) ORDER BY c.name`,
            [visible],
          );
    return reply.send(rows);
  });

  app.post('/api/companies', async (req, reply) => {
    if (!isMspAdmin(req.principal!)) return reply.code(403).send({ error: 'forbidden' });
    const body = z.object({ name: z.string().trim().min(1).max(200) }).parse(req.body);
    const { rows } = await query('INSERT INTO companies (name) VALUES ($1) RETURNING *', [body.name]);
    audit({ userId: req.principal!.id, companyId: rows[0]!.id as string, action: 'company.create', ip: req.ip });
    return reply.code(201).send(rows[0]);
  });

  app.patch('/api/companies/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!canAccessCompany(req.principal!, id, 'admin')) return reply.code(403).send({ error: 'forbidden' });
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        alertEmails: z.string().trim().max(1000).optional(), // extra offline-alert recipients
        brandName: z.string().trim().max(100).optional(), // white-label name shown on TVs
      })
      .parse(req.body);
    const { rows } = await query(
      `UPDATE companies SET name = coalesce($2, name), alert_emails = coalesce($3, alert_emails),
              brand_name = coalesce($4, brand_name)
       WHERE id = $1 RETURNING *`,
      [id, body.name ?? null, body.alertEmails ?? null, body.brandName ?? null],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    audit({ userId: req.principal!.id, companyId: id, action: 'company.update', ip: req.ip });
    return reply.send(rows[0]);
  });

  app.delete('/api/companies/:id', async (req, reply) => {
    if (!isMspAdmin(req.principal!)) return reply.code(403).send({ error: 'forbidden' });
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rowCount } = await query('DELETE FROM companies WHERE id = $1', [id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    audit({ userId: req.principal!.id, companyId: id, action: 'company.delete', ip: req.ip });
    return reply.send({ ok: true });
  });
}
