import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Company, Me, User } from '../types';

const ROLE_LABELS: Record<string, string> = {
  'msp:admin': 'MSP Admin',
  'msp:editor': 'MSP Editor',
  'company:admin': 'Company Admin',
  'company:editor': 'Company Editor',
  'company:viewer': 'Company Viewer',
};

type SortKey = 'name' | 'email' | 'role' | 'status';

/** One-time reset password: unambiguous alphabet (no 0/O/1/l/I) so it's easy to
 * read aloud or retype, well above the server's 12-char minimum. */
function generateTempPassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function Users({ me, companies }: { me: Me; companies: Company[] }) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // filters
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);
  const isMspAdmin = me.level === 'msp' && me.role === 'admin';

  // create form
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  // Must start as an option a company admin's own dropdown actually has
  // (roleOptions below excludes msp:* for them) - otherwise the <select>
  // shows its first option while roleKey silently stays 'msp:editor',
  // submitting the wrong level/role if they never touch the dropdown.
  const [roleKey, setRoleKey] = useState(isMspAdmin ? 'msp:editor' : 'company:admin');
  const [companyId, setCompanyId] = useState('');
  const [access, setAccess] = useState<string[]>([]);

  const load = useCallback(async () => {
    setUsers(await api<User[]>('/api/users'));
  }, []);

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : 'failed'));
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  };

  const create = () =>
    run(async () => {
      const [level, role] = roleKey.split(':') as ['msp' | 'company', 'admin' | 'editor' | 'viewer'];
      await api('/api/users', {
        body: {
          email, password, displayName, level, role,
          companyId: level === 'company' ? (isMspAdmin ? companyId : me.companyId) : null,
          companyAccess: level === 'msp' && role === 'editor' ? access : [],
        },
      });
      setEmail(''); setDisplayName(''); setPassword(''); setAccess([]);
      setShowCreate(false);
    });

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = users.filter((u) => {
      if (roleFilter && `${u.level}:${u.role}` !== roleFilter) return false;
      if (!term) return true;
      const company = companies.find((c) => c.id === u.company_id)?.name ?? '';
      return `${u.display_name} ${u.email} ${company}`.toLowerCase().includes(term);
    });
    const keyOf = (u: User): string => {
      switch (sortKey) {
        case 'name': return u.display_name.toLowerCase();
        case 'email': return u.email.toLowerCase();
        case 'role': return `${u.level}:${u.role}`;
        case 'status': return u.disabled ? '1' : '0';
      }
    };
    return filtered.sort((a, b) => (sortAsc ? 1 : -1) * keyOf(a).localeCompare(keyOf(b)));
  }, [users, search, roleFilter, sortKey, sortAsc, companies]);

  const sortBy = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };
  const arrow = (key: SortKey) => (sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '');

  const roleOptions = isMspAdmin
    ? Object.keys(ROLE_LABELS)
    : ['company:admin', 'company:editor', 'company:viewer'];

  return (
    <>
      <div className="row spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Users</h2>
        <button onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Close' : '+ New user'}</button>
      </div>

      {showCreate && (
        <div className="panel">
          <div className="row" style={{ marginBottom: 8 }}>
            <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            <input placeholder="Password (min 12 chars)" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} />
            <select value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
              {roleOptions.map((key) => <option key={key} value={key}>{ROLE_LABELS[key]}</option>)}
            </select>
            {roleKey.startsWith('company') && isMspAdmin && (
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                <option value="">Company…</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <button onClick={create}
              disabled={!email || !displayName || password.length < 12 || (roleKey.startsWith('company') && isMspAdmin && !companyId)}>
              Create
            </button>
          </div>
          {roleKey === 'msp:editor' && (
            <div className="row">
              <span className="muted">Company access:</span>
              {companies.map((c) => (
                <label key={c.id} className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input type="checkbox" checked={access.includes(c.id)}
                    onChange={(e) =>
                      setAccess(e.target.checked ? [...access, c.id] : access.filter((id) => id !== c.id))
                    } />
                  {c.name}
                </label>
              ))}
            </div>
          )}
          <div className="muted" style={{ marginTop: 8 }}>
            MSP accounts must enroll in 2FA at first sign-in.
          </div>
        </div>
      )}

      <div className="panel row">
        <input placeholder="Search name, email, company…" value={search}
          onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
          <option value="">All roles</option>
          {Object.entries(ROLE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <span className="muted">{visible.length} of {users.length}</span>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th style={{ cursor: 'pointer' }} onClick={() => sortBy('name')}>User{arrow('name')}</th>
              <th style={{ cursor: 'pointer' }} onClick={() => sortBy('role')}>Role{arrow('role')}</th>
              <th>Company</th>
              <th>2FA</th>
              <th style={{ cursor: 'pointer' }} onClick={() => sortBy('status')}>Status{arrow('status')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((u) => {
              const editable = u.id !== me.id && (isMspAdmin || u.level === 'company');
              const editing = editingId === u.id;
              return [
                <tr key={u.id}>
                  <td>{u.display_name}<div className="muted">{u.email}</div></td>
                  <td>{ROLE_LABELS[`${u.level}:${u.role}`]}</td>
                  <td className="muted">
                    {u.level === 'company'
                      ? companies.find((c) => c.id === u.company_id)?.name ?? ' - '
                      : u.role === 'admin'
                        ? 'All companies'
                        : `${u.company_access.length} of ${companies.length} companies`}
                  </td>
                  <td>{u.totp_enabled ? <span className="badge ok">enabled</span> : <span className="badge off">pending</span>}</td>
                  <td>{u.disabled ? <span className="badge bad">disabled</span> : <span className="badge ok">active</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    {editable && (
                      <button className="secondary" onClick={() => setEditingId(editing ? null : u.id)}>
                        {editing ? 'Close' : 'Edit'}
                      </button>
                    )}
                  </td>
                </tr>,
                editing && (
                  <tr key={`${u.id}-edit`}>
                    <td colSpan={6} style={{ background: 'var(--panel2)' }}>
                      <div className="row" style={{ marginBottom: u.level === 'msp' && u.role === 'editor' ? 10 : 0 }}>
                        <span className="muted">Role:</span>
                        <select value={u.role}
                          onChange={(e) => run(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }))}>
                          {(u.level === 'msp' ? ['admin', 'editor'] : ['admin', 'editor', 'viewer']).map((r) => (
                            <option key={r} value={r}>{ROLE_LABELS[`${u.level}:${r}`]}</option>
                          ))}
                        </select>
                        {u.level === 'company' && isMspAdmin && (
                          <>
                            <span className="muted">Company:</span>
                            <select value={u.company_id ?? ''}
                              onChange={(e) => {
                                const target = companies.find((c) => c.id === e.target.value);
                                if (confirm(`Move ${u.email} to ${target?.name}? They will only see that company's content and be signed out of active sessions.`)) {
                                  void run(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { companyId: e.target.value } }));
                                }
                              }}>
                              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                          </>
                        )}
                        <button className="secondary"
                          onClick={() => {
                            if (confirm(`Reset 2FA for ${u.email}? They must re-enroll at next sign-in.`)) {
                              void run(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { resetTotp: true } }));
                            }
                          }}>
                          Reset 2FA
                        </button>
                        <button className="secondary"
                          onClick={async () => {
                            if (!confirm(`Reset ${u.email}'s password? A new temporary password is generated ` +
                              `and shown once here - you'll need to share it with them yourself.`)) {
                              return;
                            }
                            const temp = generateTempPassword();
                            await run(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { password: temp } }));
                            alert(`New temporary password for ${u.email}:\n\n${temp}\n\n` +
                              `This won't be shown again - copy it now and have them sign in and change it.`);
                          }}>
                          Reset password
                        </button>
                        <button className="secondary"
                          onClick={() => run(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } }))}>
                          {u.disabled ? 'Enable account' : 'Disable account'}
                        </button>
                        <button className="danger"
                          onClick={() => {
                            if (confirm(`Permanently delete ${u.email}? This cannot be undone.`)) {
                              setEditingId(null);
                              void run(() => api(`/api/users/${u.id}`, { method: 'DELETE' }));
                            }
                          }}>
                          Delete user
                        </button>
                      </div>
                      {u.level === 'msp' && u.role === 'editor' && (
                        <div className="row">
                          <span className="muted">Can manage:</span>
                          {companies.map((c) => (
                            <label key={c.id} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 14 }}>
                              <input type="checkbox" checked={u.company_access.includes(c.id)} disabled={!isMspAdmin}
                                onChange={(e) =>
                                  run(() => api(`/api/users/${u.id}/company-access`, {
                                    method: 'PUT',
                                    body: {
                                      companyAccess: e.target.checked
                                        ? [...u.company_access, c.id]
                                        : u.company_access.filter((id) => id !== c.id),
                                    },
                                  }))
                                } />
                              {c.name}
                            </label>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ),
              ];
            })}
            {visible.length === 0 && <tr><td colSpan={6} className="muted">No users match.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
