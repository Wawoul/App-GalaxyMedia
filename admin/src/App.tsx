import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, clearSession, restoreSession, SESSION_EXPIRED_EVENT } from './api';
import { Account } from './pages/Account';
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
import { Icon, type IconName } from './components/icons';
import { UiProvider } from './components/ui';
import { hashFor, pageFromHash, type Page } from './route';
import { applyTheme, getTheme, nextTheme, type ThemeChoice } from './theme';
import type { Company, Me } from './types';

// The slide designer (canvas library + bundled fonts) is a separate chunk: most visits never open it.
const Designer = lazy(() => import('./designer/Designer'));

export function App() {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [page, setPageState] = useState<Page>(() => pageFromHash(window.location.hash));
  const [hash, setHash] = useState(window.location.hash);
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(getTheme);
  useEffect(() => {
    const onHash = () => { setPageState(pageFromHash(window.location.hash)); setHash(window.location.hash); setNavOpen(false); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

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

  // An expired refresh token used to leave the UI shell up with every panel
  // showing its own 401 error; drop straight to the login screen instead.
  useEffect(() => {
    const onExpired = () => setMe(null);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  if (!ready) return null;
  if (!me) return <Login onDone={() => void loadSession()} />;
  // An administrator chose this password. The server refuses everything else
  // until it is replaced, so there is nothing else worth showing.
  if (me.mustChangePassword) {
    return (
      <div className="login-wrap">
        <div style={{ width: 'min(460px, 92vw)' }}>
          <Account forced onChanged={() => void loadSession()} />
          <button className="secondary" onClick={() => { clearSession(); setMe(null); }}>Sign out</button>
        </div>
      </div>
    );
  }

  const company = companies.find((c) => c.id === companyId) ?? null;
  const isMspAdmin = me.level === 'msp' && me.role === 'admin';
  const canEdit = me.role !== 'viewer';
  const canManageUsers = isMspAdmin || (me.level === 'company' && me.role === 'admin');

  const reloadCompanies = async () => {
    const list = await api<Company[]>('/api/companies');
    setCompanies(list);
    if (!list.some((c) => c.id === companyId)) setCompanyId(list[0]?.id ?? '');
  };

  const titles: Record<Page, string> = {
    screens: 'Screens', media: 'Library', playlists: 'Playlists', layouts: 'Layouts', schedule: 'Schedule',
    reports: 'Reports', companies: 'Companies', users: 'Users', alerts: 'Alerts', system: 'System', account: 'Account',
    designer: 'Slide designer',
  };
  const link = (p: Page, icon: IconName) => (
    <a key={p} className="nav-item" href={hashFor(p)} aria-current={page === p ? 'page' : undefined}>
      <Icon name={icon} /> {titles[p]}
    </a>
  );
  const themeIcon: IconName = theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'auto';
  const brand = me.level === 'company' && company?.brand_name ? company.brand_name : 'Galaxy Media';

  return (
    <UiProvider>
    <div className="app">
      <header className="topbar">
        <button className="icon-btn" aria-label="Open menu" onClick={() => setNavOpen(true)}><Icon name="menu" size={22} /></button>
        <div className="title">{titles[page]}</div>
      </header>
      <div className={`scrim${navOpen ? ' open' : ''}`} onClick={() => setNavOpen(false)} />
      <nav className={`sidebar${navOpen ? ' open' : ''}`} aria-label="Main">
        <div className="brand"><div className="brand-mark">G</div>{brand}</div>
        <div className="brand-sub">v{__APP_VERSION__}</div>
        {companies.length > 0 && (
          <div className="company-switch">
            <label htmlFor="company-select">Company</label>
            <select id="company-select" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div className="nav-group">Content</div>
        {link('screens', 'screens')}
        {link('media', 'media')}
        {link('playlists', 'playlists')}
        {link('layouts', 'layouts')}
        {link('schedule', 'schedule')}
        {link('reports', 'reports')}
        {(me.level === 'msp' || canManageUsers) && <div className="nav-group">Admin</div>}
        {me.level === 'msp' && link('companies', 'companies')}
        {canManageUsers && link('users', 'users')}
        {isMspAdmin && link('alerts', 'alerts')}
        {isMspAdmin && link('system', 'system')}
        <div className="sidebar-spacer" />
        <div className="sidebar-foot">
          <a className="user-chip" href={hashFor('account')} aria-current={page === 'account' ? 'page' : undefined}>
            <div className="avatar">{me.displayName.slice(0, 1).toUpperCase()}</div>
            <div className="who"><b>{me.displayName}</b><small>{me.role}</small></div>
          </a>
          <button className="foot-btn" onClick={() => { const n = nextTheme(theme); applyTheme(n); setTheme(n); }}>
            <Icon name={themeIcon} /> Theme: {theme}
          </button>
          <button className="foot-btn signout" onClick={() => { clearSession(); setMe(null); }}>
            <Icon name="signout" /> Sign out
          </button>
        </div>
      </nav>
      <main className="main">
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
        {page === 'account' && <Account forced={false} onChanged={() => void loadSession()} />}
        {page === 'designer' && company && (
          <Suspense fallback={<div className="dz-root dz-center muted">Opening the designer…</div>}>
            <Designer company={company} canEdit={canEdit} hash={hash} />
          </Suspense>
        )}
        {!company && !['companies', 'users', 'alerts', 'system'].includes(page) && (
          <div className="panel muted">
            No companies yet.{' '}
            {isMspAdmin ? 'Create one under Companies.' : 'Ask your MSP admin for access.'}
          </div>
        )}
      </main>
    </div>
    </UiProvider>
  );
}
