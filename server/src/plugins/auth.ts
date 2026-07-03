import type { FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';
import { verifyToken } from '../lib/tokens.js';
import type { Principal } from '../lib/permissions.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    screenId?: string;
  }
}

interface UserRow {
  id: string;
  level: 'msp' | 'company';
  role: 'admin' | 'editor' | 'viewer';
  company_id: string | null;
  disabled: boolean;
}

async function loadPrincipal(userId: string): Promise<Principal | null> {
  const { rows } = await query<UserRow>(
    'SELECT id, level, role, company_id, disabled FROM users WHERE id = $1',
    [userId],
  );
  const user = rows[0];
  if (!user || user.disabled) return null;
  let companyAccess: string[] = [];
  if (user.level === 'msp' && user.role === 'editor') {
    const access = await query<{ company_id: string }>(
      'SELECT company_id FROM user_company_access WHERE user_id = $1',
      [userId],
    );
    companyAccess = access.rows.map((r) => r.company_id);
  }
  return {
    id: user.id,
    level: user.level,
    role: user.role,
    companyId: user.company_id,
    companyAccess,
  };
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

/**
 * preHandler: authenticated human user. Loads the principal fresh on every
 * request so access-list/role changes take effect immediately (SPEC §2).
 */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearerToken(req);
  const claims = token ? verifyToken(token) : null;
  if (!claims || claims.typ !== 'user') {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
  const principal = await loadPrincipal(claims.sub);
  if (!principal) {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
  req.principal = principal;
}

/**
 * preHandler: authenticated device. The token's jti must match the screen's
 * current device_token_jti - clearing that column revokes the device instantly.
 */
export async function requireDevice(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearerToken(req);
  const claims = token ? verifyToken(token) : null;
  if (!claims || claims.typ !== 'device') {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
  const { rows } = await query<{ id: string }>(
    'SELECT id FROM screens WHERE id = $1 AND device_token_jti = $2',
    [claims.sub, claims.jti],
  );
  if (!rows[0]) {
    return reply.code(401).send({ error: 'revoked' });
  }
  req.screenId = claims.sub;
}
