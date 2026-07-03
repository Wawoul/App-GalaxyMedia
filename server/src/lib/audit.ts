import { query } from '../db/pool.js';

export interface AuditEntry {
  userId?: string | null;
  companyId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  ip?: string;
  detail?: Record<string, unknown>;
}

/** Fire-and-forget audit write; never lets logging break the request. */
export function audit(entry: AuditEntry): void {
  void query(
    `INSERT INTO audit_log (user_id, company_id, action, entity, entity_id, ip, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.userId ?? null,
      entry.companyId ?? null,
      entry.action,
      entry.entity ?? null,
      entry.entityId ?? null,
      entry.ip ?? null,
      entry.detail ? JSON.stringify(entry.detail) : null,
    ],
  ).catch(() => {
    /* logged elsewhere; never throw from audit */
  });
}
