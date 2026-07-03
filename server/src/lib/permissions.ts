/**
 * The single permission-resolution path (SPEC §2): every check answers
 * "which companies can this user act on, and at what level?"
 */

export type Role = 'admin' | 'editor' | 'viewer';
export type Level = 'msp' | 'company';

export interface Principal {
  id: string;
  level: Level;
  role: Role;
  companyId: string | null; // company users only
  companyAccess: string[]; // msp_editor access list; ignored otherwise
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export function isMspAdmin(p: Principal): boolean {
  return p.level === 'msp' && p.role === 'admin';
}

/** Role this principal effectively holds within `companyId`, or null if no access. */
export function roleInCompany(p: Principal, companyId: string): Role | null {
  if (p.level === 'msp') {
    if (p.role === 'admin') return 'admin';
    return p.companyAccess.includes(companyId) ? 'editor' : null;
  }
  return p.companyId === companyId ? p.role : null;
}

export function canAccessCompany(p: Principal, companyId: string, minRole: Role): boolean {
  const role = roleInCompany(p, companyId);
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/**
 * Companies visible to this principal. Returns 'all' for MSP admins so callers
 * can skip the WHERE clause; otherwise an explicit id list.
 */
export function visibleCompanies(p: Principal): 'all' | string[] {
  if (isMspAdmin(p)) return 'all';
  if (p.level === 'msp') return p.companyAccess;
  return p.companyId ? [p.companyId] : [];
}

/** May this principal manage users of a given company (or MSP users for null)? */
export function canManageUsers(p: Principal, companyId: string | null): boolean {
  if (isMspAdmin(p)) return true;
  // Company admins manage only their own company's users.
  return (
    p.level === 'company' && p.role === 'admin' && companyId !== null && p.companyId === companyId
  );
}
