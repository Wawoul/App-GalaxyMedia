import { describe, expect, it } from 'vitest';
import {
  canAccessCompany,
  canManageUsers,
  isMspAdmin,
  roleInCompany,
  visibleCompanies,
  type Principal,
} from './permissions.js';

const C1 = 'c1000000-0000-0000-0000-000000000001';
const C2 = 'c2000000-0000-0000-0000-000000000002';

const mspAdmin: Principal = { id: 'u1', level: 'msp', role: 'admin', companyId: null, companyAccess: [] };
const mspEditor: Principal = { id: 'u2', level: 'msp', role: 'editor', companyId: null, companyAccess: [C1] };
const companyAdmin: Principal = { id: 'u3', level: 'company', role: 'admin', companyId: C1, companyAccess: [] };
const companyViewer: Principal = { id: 'u4', level: 'company', role: 'viewer', companyId: C1, companyAccess: [] };

describe('permission resolution (single path, SPEC §2)', () => {
  it('msp admin can act on any company at admin level', () => {
    expect(isMspAdmin(mspAdmin)).toBe(true);
    expect(canAccessCompany(mspAdmin, C1, 'admin')).toBe(true);
    expect(canAccessCompany(mspAdmin, C2, 'admin')).toBe(true);
    expect(visibleCompanies(mspAdmin)).toBe('all');
  });

  it('msp editor sees exactly their access list, at editor level', () => {
    expect(visibleCompanies(mspEditor)).toEqual([C1]);
    expect(canAccessCompany(mspEditor, C1, 'editor')).toBe(true);
    expect(canAccessCompany(mspEditor, C1, 'admin')).toBe(false); // never admin
    expect(canAccessCompany(mspEditor, C2, 'viewer')).toBe(false); // not on list at all
    expect(roleInCompany(mspEditor, C2)).toBeNull();
  });

  it('removing a company from the access list locks the editor out', () => {
    const revoked: Principal = { ...mspEditor, companyAccess: [] };
    expect(canAccessCompany(revoked, C1, 'viewer')).toBe(false);
    expect(visibleCompanies(revoked)).toEqual([]);
  });

  it('company users are confined to their own company', () => {
    expect(canAccessCompany(companyAdmin, C1, 'admin')).toBe(true);
    expect(canAccessCompany(companyAdmin, C2, 'viewer')).toBe(false); // cross-tenant
    expect(canAccessCompany(companyViewer, C1, 'viewer')).toBe(true);
    expect(canAccessCompany(companyViewer, C1, 'editor')).toBe(false);
  });

  it('user management: msp admin anywhere, company admin only at home', () => {
    expect(canManageUsers(mspAdmin, null)).toBe(true);
    expect(canManageUsers(mspAdmin, C2)).toBe(true);
    expect(canManageUsers(mspEditor, C1)).toBe(false); // editors never manage users
    expect(canManageUsers(companyAdmin, C1)).toBe(true);
    expect(canManageUsers(companyAdmin, C2)).toBe(false);
    expect(canManageUsers(companyViewer, C1)).toBe(false);
  });
});
