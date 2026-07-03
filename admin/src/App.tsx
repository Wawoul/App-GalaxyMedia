import { useCallback, useEffect, useState } from 'react';
import { api, clearSession, restoreSession } from './api';
import { Alerts } from './pages/Alerts';
import { Companies } from './pages/Companies';
import { Login } from './pages/Login';
import { Layouts } from './pages/Layouts';
import { Media } from './pages/Media';
import { Playlists } from './pages/Playlists';
import { Reports } from './pages/Reports';
import { Schedule } from './pages/Schedule';
import { Screens } from './pages/Screens';
import { System } from './pages/System';
import { Users } from './pages/Users';
import type { Company, Me } from './types';

type Page =
  | 'screens' | 'media' | 'playlists' | 'layouts' | 'schedule' | 'reports'
  | 'companies' | 'users' | 'alerts' | 'system';

export function App() {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [page, setPage] = useState<Page>('screens');

  const loadSession = useCallback(async () => {
    const user = await api<Me>('/api/auth/me');
    const list = await api<Company[]>('/api/companies');
    setMe(user);
    setCompanies(list);
    setCompanyId((current) => current || list[0]?.id || '');
  }, []);

  useEffect(() => {
    restoreSession()
      .then((ok) => (ok ? loadSession() : undefined))
      .finally(() => setReady(true));
  }, [loadSession]);

  if (!ready) return null;
  if (!me) return <Login onDone={() => void loadSession()} />;

  const company = companies.find((c) => c.id === companyId) ?? null;
  const isMspAdmin = me.level === 'msp' && me.role === 'admin';
  const canEdit = me.role !== 'viewer';
  const canManageUsers = isMspAdmin || (me.level === 'company' && me.role === 'admin');

  const reloadCompanies = async () => {
    const list = await api<Company[]>('/api/companies');
    setCompanies(list);
    if (!list.some((c) => c.id === companyId)) setCompanyId(list[0]?.id ?? '');
  };

  return (
    <div className="layout">
      <nav className="sidebar">
        {me.level === 'company' && company?.brand_name ? (
          <div className="brand" style={{ marginBottom: 4 }}>{company.brand_name}</div>
        ) : (
          <div className="brand" style={{ marginBottom: 4 }}>Galaxy <span>Media</span></div>
        )}
        <div className="muted" style={{ fontSize: 11, marginBottom: 14 }}>v{__APP_VERSION__}</div>
        {companies.length > 0 && (
          <>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Working in company</div>
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} style={{ marginBottom: 12 }}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </>
        )}
        <button className={page === 'screens' ? 'active' : ''} onClick={() => setPage('screens')}>Screens</button>
        <button className={page === 'media' ? 'active' : ''} onClick={() => setPage('media')}>Media</button>
        <button className={page === 'playlists' ? 'active' : ''} onClick={() => setPage('playlists')}>Playlists</button>
        <button className={page === 'layouts' ? 'active' : ''} onClick={() => setPage('layouts')}>Layouts</button>
        <button className={page === 'schedule' ? 'active' : ''} onClick={() => setPage('schedule')}>Schedule</button>
        <button className={page === 'reports' ? 'active' : ''} onClick={() => setPage('reports')}>Reports</button>
        {(me.level === 'msp' || canManageUsers) && <hr className="divider" />}
        {me.level === 'msp' && (
          <button className={page === 'companies' ? 'active' : ''} onClick={() => setPage('companies')}>Companies</button>
        )}
        {canManageUsers && (
          <button className={page === 'users' ? 'active' : ''} onClick={() => setPage('users')}>Users</button>
        )}
        {isMspAdmin && (
          <button className={page === 'alerts' ? 'active' : ''} onClick={() => setPage('alerts')}>Alerts</button>
        )}
        {isMspAdmin && (
          <button className={page === 'system' ? 'active' : ''} onClick={() => setPage('system')}>System</button>
        )}
        <div style={{ flex: 1 }} />
        <div className="muted">{me.displayName}</div>
        <button className="signout" onClick={() => { clearSession(); setMe(null); }}>Sign out</button>
      </nav>
      <main className="main">
        {company && !['companies', 'users', 'alerts', 'system'].includes(page) && (
          <div className="muted" style={{ marginBottom: 8 }}>
            Company: <strong style={{ color: 'var(--text)' }}>{company.name}</strong>
          </div>
        )}
        {page === 'screens' && company && (
          <Screens company={company} companies={companies} canEdit={canEdit} />
        )}
        {page === 'media' && company && <Media company={company} canEdit={canEdit} />}
        {page === 'playlists' && company && <Playlists company={company} canEdit={canEdit} />}
        {page === 'layouts' && company && <Layouts company={company} canEdit={canEdit} />}
        {page === 'schedule' && company && <Schedule company={company} canEdit={canEdit} />}
        {page === 'reports' && company && <Reports company={company} />}
        {page === 'companies' && (
          <Companies companies={companies} reload={reloadCompanies} canCreate={isMspAdmin} />
        )}
        {page === 'users' && <Users me={me} companies={companies} />}
        {page === 'alerts' && <Alerts />}
        {page === 'system' && <System />}
        {!company && !['companies', 'users', 'alerts', 'system'].includes(page) && (
          <div className="panel muted">
            No companies yet.{' '}
            {isMspAdmin ? 'Create one under Companies.' : 'Ask your MSP admin for access.'}
          </div>
        )}
      </main>
    </div>
  );
}
