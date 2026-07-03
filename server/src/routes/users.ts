import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { canManageUsers, isMspAdmin } from '../lib/permissions.js';
import { requireUser } from '../plugins/auth.js';

const createUserSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(12).max(200),
    displayName: z.string().trim().min(1).max(100),
    level: z.enum(['msp', 'company']),
    role: z.enum(['admin', 'editor', 'viewer']),
    companyId: z.string().uuid().nullish(),
    companyAccess: z.array(z.string().uuid()).default([]), // msp editors only
  })
  .refine((u) => (u.level === 'msp' ? !u.companyId : !!u.companyId), {
    message: 'company users need companyId; msp users must not have one',
  })
  .refine((u) => !(u.level === 'msp' && u.role === 'viewer'), {
    message: 'msp users cannot be viewers',
  });

export function userRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', requireUser);

  app.get('/api/users', async (req, reply) => {
    const p = req.principal!;
    let rows;
    if (isMspAdmin(p)) {
      ({ rows } = await query(
        `SELECT u.id, u.email, u.display_name, u.level, u.role, u.company_id, u.totp_enabled,
                u.disabled, u.created_at,
                coalesce(array_agg(a.company_id) FILTER (WHERE a.company_id IS NOT NULL), '{}') AS company_access
         FROM users u LEFT JOIN user_company_access a ON a.user_id = u.id
         GROUP BY u.id ORDER BY u.created_at`,
      ));
    } else if (canManageUsers(p, p.companyId)) {
      ({ rows } = await query(
        `SELECT id, email, display_name, level, role, company_id, totp_enabled, disabled, created_at,
                '{}'::uuid[] AS company_access
         FROM users WHERE company_id = $1 ORDER BY created_at`,
        [p.companyId],
      ));
    } else {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return reply.send(rows);
  });

  app.post('/api/users', async (req, reply) => {
    const p = req.principal!;
    const body = createUserSchema.parse(req.body);

    // MSP admins create anyone; company admins create users in their own company only.
    const allowed =
      isMspAdmin(p) ||
      (body.level === 'company' && body.companyId != null && canManageUsers(p, body.companyId));
    if (!allowed) return reply.code(403).send({ error: 'forbidden' });

    const hash = await argon2.hash(body.password, { type: argon2.argon2id });
    const user = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO users (email, password_hash, display_name, level, role, company_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, display_name, level, role, company_id, totp_enabled, disabled, created_at`,
        [body.email, hash, body.displayName, body.level, body.role, body.companyId ?? null],
      );
      const created = rows[0]!;
      if (body.level === 'msp' && body.role === 'editor') {
        for (const companyId of body.companyAccess) {
          await tx.query('INSERT INTO user_company_access (user_id, company_id) VALUES ($1, $2)', [
            created.id,
            companyId,
          ]);
        }
      }
      return created;
    });
    audit({ userId: p.id, action: 'user.create', entity: 'user', entityId: user.id as string, ip: req.ip });
    return reply.code(201).send(user);
  });

  // Replace an msp_editor's company access list (takes effect immediately - // principals are loaded per request).
  app.put('/api/users/:id/company-access', async (req, reply) => {
    const p = req.principal!;
    if (!isMspAdmin(p)) return reply.code(403).send({ error: 'forbidden' });
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ companyAccess: z.array(z.string().uuid()) }).parse(req.body);

    const { rows } = await query<{ level: string; role: string }>(
      'SELECT level, role FROM users WHERE id = $1',
      [id],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (rows[0].level !== 'msp' || rows[0].role !== 'editor') {
      return reply.code(400).send({ error: 'not_an_msp_editor' });
    }

    await withTransaction(async (tx) => {
      await tx.query('DELETE FROM user_company_access WHERE user_id = $1', [id]);
      for (const companyId of body.companyAccess) {
        await tx.query('INSERT INTO user_company_access (user_id, company_id) VALUES ($1, $2)', [
          id,
          companyId,
        ]);
      }
    });
    audit({
      userId: p.id,
      action: 'user.set_company_access',
      entity: 'user',
      entityId: id,
      ip: req.ip,
      detail: { companyAccess: body.companyAccess },
    });
    return reply.send({ ok: true });
  });

  app.patch('/api/users/:id', async (req, reply) => {
    const p = req.principal!;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        displayName: z.string().trim().min(1).max(100).optional(),
        disabled: z.boolean().optional(),
        password: z.string().min(12).max(200).optional(),
        resetTotp: z.boolean().optional(), // forces re-enrollment; never disables the requirement
        role: z.enum(['admin', 'editor', 'viewer']).optional(), // within the user's existing level
        companyId: z.string().uuid().optional(), // move a company-level user to another company
      })
      .parse(req.body);

    const { rows } = await query<{ company_id: string | null; level: string }>(
      'SELECT company_id, level FROM users WHERE id = $1',
      [id],
    );
    const target = rows[0];
    if (!target) return reply.code(404).send({ error: 'not_found' });
    const allowed = isMspAdmin(p) || (target.level === 'company' && canManageUsers(p, target.company_id));
    if (!allowed) return reply.code(403).send({ error: 'forbidden' });
    if (id === p.id && (body.disabled || body.role)) {
      return reply.code(400).send({ error: 'cannot_change_self' });
    }
    // Validate every sub-operation BEFORE mutating anything: a request with
    // several fields must not partially apply (e.g. a role change committing
    // even though the companyId move in the same request gets rejected).
    if (body.role !== undefined && target.level === 'msp' && body.role === 'viewer') {
      return reply.code(400).send({ error: 'msp_users_cannot_be_viewers' });
    }
    if (body.companyId !== undefined) {
      // Only MSP admins move users between companies, and only company-level users.
      if (!isMspAdmin(p)) return reply.code(403).send({ error: 'forbidden' });
      if (target.level !== 'company') return reply.code(400).send({ error: 'not_a_company_user' });
      const { rowCount } = await query('SELECT 1 FROM companies WHERE id = $1', [body.companyId]);
      if (!rowCount) return reply.code(400).send({ error: 'company_not_found' });
    }

    await withTransaction(async (tx) => {
      if (body.role !== undefined) {
        await tx.query('UPDATE users SET role = $2 WHERE id = $1', [id, body.role]);
        // Promoting an msp editor to admin makes the access list irrelevant; clear it.
        if (target.level === 'msp' && body.role === 'admin') {
          await tx.query('DELETE FROM user_company_access WHERE user_id = $1', [id]);
        }
      }
      if (body.companyId !== undefined) {
        await tx.query('UPDATE users SET company_id = $2 WHERE id = $1', [id, body.companyId]);
        await tx.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [id]);
      }
      if (body.displayName !== undefined) {
        await tx.query('UPDATE users SET display_name = $2 WHERE id = $1', [id, body.displayName]);
      }
      if (body.disabled !== undefined) {
        await tx.query('UPDATE users SET disabled = $2 WHERE id = $1', [id, body.disabled]);
        if (body.disabled) {
          await tx.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [id]);
        }
      }
      if (body.password !== undefined) {
        const hash = await argon2.hash(body.password, { type: argon2.argon2id });
        await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, hash]);
        await tx.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [id]);
      }
      if (body.resetTotp) {
        await tx.query(
          `UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, recovery_codes = '{}' WHERE id = $1`,
          [id],
        );
        await tx.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [id]);
      }
    });
    audit({
      userId: p.id,
      action: 'user.update',
      entity: 'user',
      entityId: id,
      ip: req.ip,
      detail: {
        fields: Object.keys(body),
      },
    });
    return reply.send({ ok: true });
  });

  app.delete('/api/users/:id', async (req, reply) => {
    const p = req.principal!;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (id === p.id) return reply.code(400).send({ error: 'cannot_delete_self' });

    const { rows } = await query<{ company_id: string | null; level: string; role: string }>(
      'SELECT company_id, level, role FROM users WHERE id = $1',
      [id],
    );
    const target = rows[0];
    if (!target) return reply.code(404).send({ error: 'not_found' });
    const allowed = isMspAdmin(p) || (target.level === 'company' && canManageUsers(p, target.company_id));
    if (!allowed) return reply.code(403).send({ error: 'forbidden' });

    // Never delete the last active MSP admin - that would lock everyone out.
    if (target.level === 'msp' && target.role === 'admin') {
      const { rows: admins } = await query<{ count: string }>(
        `SELECT count(*) FROM users WHERE level = 'msp' AND role = 'admin' AND NOT disabled`,
      );
      if (Number(admins[0]?.count ?? 0) <= 1) {
        return reply.code(400).send({ error: 'cannot_delete_last_msp_admin' });
      }
    }
    await query('DELETE FROM users WHERE id = $1', [id]);
    audit({ userId: p.id, action: 'user.delete', entity: 'user', entityId: id, ip: req.ip });
    return reply.send({ ok: true });
  });
}
