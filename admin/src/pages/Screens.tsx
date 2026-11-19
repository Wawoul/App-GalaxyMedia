import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../components/icons';
import { EmptyState, Menu, Modal, Skeleton, StatusDot, useMediaQuery, useUi, type MenuItem } from '../components/ui';
import type { Company, Group, Screen } from '../types';

function formatUptime(s: number): string {
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Coarse "how long ago" for timestamps that are history rather than live state. */
function formatAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const days = Math.floor(seconds / 86400);
  if (days > 0) return days === 1 ? '1 day ago' : `${days} days ago`;
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes <= 1 ? 'just now' : `${minutes} minutes ago`;
}

/** Rows for the device-health popup; null values render as "-". */
function healthRows(s: Screen): [string, string][] {
  return [
    ['Status', !s.paired ? 'unpaired' : s.online ? 'online' : 'offline'],
    ['Now playing', s.current_item ?? '-'],
    ['Battery', s.battery_pct != null ? `${s.battery_pct}%` : '-'],
    ['RAM free', s.ram_free_mb != null ? `${s.ram_free_mb}${s.ram_total_mb ? ` / ${s.ram_total_mb}` : ''} MB` : '-'],
    ['Player CPU', s.cpu_pct != null ? `${s.cpu_pct}%` : '-'],
    ['WiFi signal', s.wifi_rssi != null ? `${s.wifi_rssi} dBm` : '- (ethernet?)'],
    ['Storage free', s.storage_free_mb != null ? `${(s.storage_free_mb / 1024).toFixed(1)} GB` : '-'],
    ['Uptime', s.uptime_s != null ? formatUptime(s.uptime_s) : '-'],
    ['Rotation', s.orientation ? `${s.orientation}°` : 'landscape (0°)'],
    // Two addresses, because they differ whenever the screen sits behind a
    // router: local_ip is what the device reports for itself (the one to adb
    // into), s.ip is whichever hop reached the server.
    // Shown before the IPs: a screen that can't fetch its media plays nothing
    // and otherwise looks identical to an idle one.
    ['Media download', s.media_error ? `FAILING - ${s.media_error}` : 'ok'],
    ['IP address (device)', s.local_ip ?? '- (needs player 1.3.8+)'],
    ['Seen by server as', s.ip ?? '-'],
    ['App version', s.app_version ?? '-'],
    ['Last seen', s.last_seen_at ? new Date(s.last_seen_at).toLocaleString() : 'never'],
    [
      // Historical, not a live status: the server keeps the last reported crash
      // indefinitely, so label the age to stop an old entry reading as "broken now".
      'Last crash',
      s.last_crash_at
        ? `${formatAgo(s.last_crash_at)} (${new Date(s.last_crash_at).toLocaleString()}) - ` +
          `${s.last_crash_message ?? 'unknown'}`
        : 'none reported',
    ],
  ];
}

type Status = 'online' | 'offline' | 'unpaired';
const statusOf = (s: Screen): Status => (!s.paired ? 'unpaired' : s.online ? 'online' : 'offline');
const VIEW_KEY = 'gm:screens-view';

export function Screens({
  company,
  companies,
  canEdit,
}: {
  company: Company;
  companies: Company[];
  canEdit: boolean;
}) {
  const ui = useUi();
  const narrow = useMediaQuery('(max-width: 700px)');
  const [screens, setScreens] = useState<Screen[]>([]);
  // Mirrors `screens` so handlers can read the latest rows without closing over
  // a snapshot the background refresh has since replaced.
  const screensRef = useRef<Screen[]>([]);
  screensRef.current = screens;
  const [groups, setGroups] = useState<Group[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  // pairing form
  const [pairOpen, setPairOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [pairing, setPairing] = useState(false);
  // per-screen modals
  const [groupsEditId, setGroupsEditId] = useState<string | null>(null);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [rotation, setRotation] = useState('0');
  const [shotId, setShotId] = useState<string | null>(null);
  const [healthId, setHealthId] = useState<string | null>(null);
  // list controls
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'status' | 'last_seen'>('name');
  const [filterGroup, setFilterGroup] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | Status>('all');
  const [view, setView] = useState<'cards' | 'table'>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'cards'; } catch { return 'cards'; }
  });
  const setViewPersist = (v: 'cards' | 'table') => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-visit only */ }
  };

  const load = useCallback(async () => {
    try {
      const [s, g] = await Promise.all([
        api<Screen[]>(`/api/screens?companyId=${company.id}`),
        api<Group[]>(`/api/companies/${company.id}/groups`),
      ]);
      setScreens(s);
      setGroups(g);
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoaded(true);
    }
  }, [company.id]);

  useEffect(() => {
    setLoaded(false);
    void load();
    const timer = setInterval(load, 15000); // keep online status fresh
    return () => clearInterval(timer);
  }, [load]);

  const fail = (err: unknown, fallback = 'Something went wrong') =>
    ui.toast(err instanceof Error ? err.message : fallback, 'error');

  const pair = async () => {
    setPairing(true);
    try {
      await api('/api/screens/pair', {
        body: { code: code.toUpperCase(), companyId: company.id, name, groupIds: groupId ? [groupId] : [] },
      });
      ui.toast(`Paired "${name}"`, 'ok');
      setPairOpen(false);
      setCode('');
      setName('');
      setGroupId('');
      await load();
    } catch (err) {
      fail(err, 'Could not pair that screen');
    } finally {
      setPairing(false);
    }
  };

  const addGroup = async () => {
    const groupName = await ui.prompt({ title: 'New group', label: 'Group name', confirmLabel: 'Add group', hint: 'Groups let you assign content to several screens at once.' });
    if (!groupName) return;
    try {
      await api(`/api/companies/${company.id}/groups`, { body: { name: groupName } });
      ui.toast(`Group "${groupName}" added`, 'ok');
      await load();
    } catch (err) {
      fail(err, 'Could not add that group');
    }
  };

  const sendCommand = async (screen: Screen, action: string) => {
    try {
      const cmd = await api<{ ok: boolean; delivered: boolean }>(
        `/api/screens/${screen.id}/command`,
        { body: { command: action } },
      );
      if (!cmd.delivered) {
        ui.toast(`"${screen.name}" didn't receive the command - it may have just gone offline.`, 'error');
        return;
      }
      ui.toast(action === 'screenshot' ? `Screenshot requested from "${screen.name}"` : `Command sent to "${screen.name}"`, 'ok');
      if (action === 'screenshot') {
        setShotId(screen.id);
        setTimeout(() => void load(), 4000); // give the TV a moment to upload
      }
    } catch (err) {
      fail(err);
    }
  };

  const runCommand = async (screen: Screen, action: string) => {
    if (action === 'restart' && !(await ui.confirm({
      title: `Restart the app on "${screen.name}"?`, message: 'Playback briefly interrupts.', confirmLabel: 'Restart',
    }))) return;
    if (action === 'clear_cache' && !(await ui.confirm({
      title: `Clear "${screen.name}"'s media cache?`,
      message: 'Everything re-downloads, which can take a while and uses bandwidth.', confirmLabel: 'Clear cache', danger: true,
    }))) return;
    if (action === 'update' && !(await ui.confirm({
      title: `Install the latest app on "${screen.name}"?`,
      message: 'Android shows an on-screen confirm prompt that STOPS playback until someone taps it at the TV. Only send this if a tech is on-site right now to approve it.',
      confirmLabel: 'Send update',
    }))) return;
    await sendCommand(screen, action);
  };

  const renameScreen = async (screen: Screen) => {
    const next = await ui.prompt({ title: 'Rename screen', label: 'Screen name', initial: screen.name });
    if (!next || next === screen.name) return;
    try {
      await api(`/api/screens/${screen.id}`, { method: 'PATCH', body: { name: next } });
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const saveRotation = async (screen: Screen) => {
    try {
      await api(`/api/screens/${screen.id}`, { method: 'PATCH', body: { orientation: Number(rotation) } });
      setRotateId(null);
      ui.toast('Rotation saved', 'ok');
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const unpair = async (screen: Screen) => {
    if (!(await ui.confirm({
      title: `Unpair "${screen.name}"?`, message: 'The TV returns to its pairing screen.', confirmLabel: 'Unpair', danger: true,
    }))) return;
    try {
      await api(`/api/screens/${screen.id}/unpair`, { body: {} });
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const deleteScreen = async (screen: Screen) => {
    if (!(await ui.confirm({
      title: `Delete "${screen.name}"?`,
      message: 'This removes the screen completely. The TV will show its pairing screen again.', confirmLabel: 'Delete screen', danger: true,
    }))) return;
    try {
      await api(`/api/screens/${screen.id}`, { method: 'DELETE' });
      ui.toast(`Deleted "${screen.name}"`, 'ok');
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const toggleGroup = async (screen: Screen, gid: string, on: boolean) => {
    // Read the freshest row rather than the one captured when this row rendered:
    // the 15s refresh replaces `screens` wholesale, so two ticks within that
    // window would send a stale list and silently undo the first change.
    const current = screensRef.current.find((s) => s.id === screen.id) ?? screen;
    const base = current.group_ids;
    const next = on ? [...new Set([...base, gid])] : base.filter((x) => x !== gid);
    try {
      await api(`/api/screens/${screen.id}`, { method: 'PATCH', body: { groupIds: next } });
      await load();
    } catch (err) {
      fail(err, 'Could not update groups');
    }
  };

  const moveScreen = async (screen: Screen) => {
    const target = companies.find((c) => c.id === moveTarget);
    if (!target) return;
    if (!(await ui.confirm({
      title: `Move "${screen.name}" to ${target.name}?`,
      message: "Its group memberships and direct assignments are removed; the TV will switch to that company's content.",
      confirmLabel: 'Move screen',
    }))) return;
    try {
      await api(`/api/screens/${screen.id}/move`, { body: { companyId: moveTarget } });
      setMoveId(null);
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const menuFor = (s: Screen): MenuItem[] => {
    const offline = !s.online;
    const cmd = (label: string, action: string, extra: Partial<MenuItem> = {}): MenuItem => ({
      label, disabled: offline, hint: offline ? 'Screen is offline' : undefined, onSelect: () => void runCommand(s, action), ...extra,
    });
    const items: MenuItem[] = [{ label: 'Device health', icon: 'reports', onSelect: () => setHealthId(s.id) }];
    if (s.screenshot_url) items.push({ label: 'View last screenshot', icon: 'image', onSelect: () => setShotId(s.id) });
    if (canEdit) {
      items.push(
        cmd('Take screenshot', 'screenshot', { icon: 'image' }),
        cmd('Identify (flash name on TV)', 'identify', { icon: 'check' }),
        cmd('Reload content', 'reload'),
        cmd('Restart app', 'restart'),
        cmd('Clear media cache', 'clear_cache'),
        cmd('Install latest app update…', 'update'),
        { label: 'Rename', separator: true, onSelect: () => void renameScreen(s) },
        { label: 'Set rotation…', onSelect: () => { setRotation(String(s.orientation ?? 0)); setRotateId(s.id); } },
        { label: 'Edit groups…', onSelect: () => setGroupsEditId(s.id) },
      );
      if (companies.length > 1) items.push({ label: 'Move to another company…', onSelect: () => { setMoveTarget(''); setMoveId(s.id); } });
      items.push(
        { label: 'Unpair', separator: true, danger: true, onSelect: () => void unpair(s) },
        { label: 'Delete screen', danger: true, onSelect: () => void deleteScreen(s) },
      );
    }
    return items;
  };

  const counts = {
    all: screens.length,
    online: screens.filter((s) => statusOf(s) === 'online').length,
    offline: screens.filter((s) => statusOf(s) === 'offline').length,
    unpaired: screens.filter((s) => statusOf(s) === 'unpaired').length,
  };
  const query = search.trim().toLowerCase();
  const visible = screens
    .filter((s) => statusFilter === 'all' || statusOf(s) === statusFilter)
    .filter((s) => !filterGroup || s.group_ids.includes(filterGroup))
    .filter((s) => !query || s.name.toLowerCase().includes(query)
      || (s.current_item ?? '').toLowerCase().includes(query)
      || (s.playlist_name ?? '').toLowerCase().includes(query))
    .sort((a, b) => {
      if (sortBy === 'status') {
        const rank = (s: Screen) => (!s.paired ? 1 : s.online ? 2 : 0); // offline, unpaired, online
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
      }
      if (sortBy === 'last_seen') {
        const at = (s: Screen) => (s.last_seen_at ? new Date(s.last_seen_at).getTime() : 0);
        if (at(a) !== at(b)) return at(b) - at(a); // most recent first
      }
      return a.name.localeCompare(b.name);
    });
  const groupNames = (s: Screen) => s.group_ids.map((id) => groups.find((g) => g.id === id)?.name).filter(Boolean).join(', ') || '-';
  const byId = (id: string | null) => (id ? screens.find((s) => s.id === id) ?? null : null);
  const healthScreen = byId(healthId);
  const shotScreen = byId(shotId);
  const groupsScreen = byId(groupsEditId);
  const moveScreenRow = byId(moveId);
  const rotateScreen = byId(rotateId);
  const filtering = !!(search || filterGroup || statusFilter !== 'all');
  const showCards = narrow || view === 'cards';
  const pairButton = canEdit && (
    <button className="btn btn-primary" onClick={() => setPairOpen(true)}><Icon name="plus" /> Pair screen</button>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Screens</h2>
          <div className="page-sub">{loaded ? `${counts.online} of ${counts.all} online` : 'Loading…'}</div>
        </div>
        {canEdit && (
          <div className="page-actions">
            <button className="btn" onClick={() => void addGroup()}>Add group</button>
            {pairButton}
          </div>
        )}
      </div>

      {loadError && <div className="panel error" role="alert">Could not load screens: {loadError}</div>}

      {!loaded ? (
        <div className="panel"><Skeleton lines={4} /></div>
      ) : screens.length === 0 ? (
        <div className="panel">
          <EmptyState icon="tv" title="No screens yet" action={pairButton}>
            Open the Galaxy Media app on a TV to see its 6-character pairing code, then pair it here.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="stats">
            {([['all', 'All screens'], ['online', 'Online'], ['offline', 'Offline'], ['unpaired', 'Unpaired']] as const).map(([key, label]) => (
              <button key={key} className="stat" aria-pressed={statusFilter === key} onClick={() => setStatusFilter(key)}>
                {key !== 'all' && <StatusDot state={key} />}
                <span><b>{counts[key]}</b><small>{label}</small></span>
              </button>
            ))}
          </div>

          <div className="toolbar">
            <div className="search">
              <Icon name="search" size={16} />
              <input type="search" aria-label="Search screens" placeholder="Search screens…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <select aria-label="Filter by group" value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)}>
              <option value="">All groups</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <select aria-label="Sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
              <option value="name">Sort: Name</option>
              <option value="status">Sort: Offline first</option>
              <option value="last_seen">Sort: Last seen</option>
            </select>
            <div className="grow" />
            {!narrow && (
              <div className="seg" role="group" aria-label="View">
                <button aria-pressed={view === 'cards'} onClick={() => setViewPersist('cards')}><Icon name="grid" size={16} /> Cards</button>
                <button aria-pressed={view === 'table'} onClick={() => setViewPersist('table')}><Icon name="list" size={16} /> Table</button>
              </div>
            )}
          </div>

          {visible.length === 0 ? (
            <div className="panel">
              <EmptyState icon="search" title="No screens match"
                action={filtering ? <button className="btn" onClick={() => { setSearch(''); setFilterGroup(''); setStatusFilter('all'); }}>Clear filters</button> : undefined}>
                Try a different search or filter.
              </EmptyState>
            </div>
          ) : showCards ? (
            <div className="card-grid">
              {visible.map((s) => (
                <div className="card" key={s.id}>
                  <div className="card-top">
                    <StatusDot state={statusOf(s)} />
                    <div className="card-title"><button className="crumb" title="Device health" onClick={() => setHealthId(s.id)}>{s.name}</button></div>
                    <Menu items={menuFor(s)} label={`Actions for ${s.name}`} />
                  </div>
                  <button className="thumb-box" style={{ cursor: s.screenshot_url ? 'zoom-in' : 'default', padding: 0 }}
                    aria-label={s.screenshot_url ? `View screenshot of ${s.name}` : undefined}
                    onClick={() => s.screenshot_url && setShotId(s.id)} tabIndex={s.screenshot_url ? 0 : -1}>
                    {s.screenshot_url ? <img src={s.screenshot_url} alt="" loading="lazy" /> : <Icon name="tv" size={30} />}
                  </button>
                  <dl className="kv">
                    <dt>Playlist</dt><dd>{s.playlist_name ?? 'none assigned'}</dd>
                    <dt>Now playing</dt><dd>{s.current_item ?? '-'}</dd>
                    <dt>Groups</dt><dd>{groupNames(s)}</dd>
                    <dt>Last seen</dt><dd title={s.last_seen_at ? new Date(s.last_seen_at).toLocaleString() : undefined}>{s.last_seen_at ? formatAgo(s.last_seen_at) : 'never'}</dd>
                  </dl>
                  {s.media_error && <span className="badge bad">Media download failing</span>}
                </div>
              ))}
            </div>
          ) : (
            <div className="panel" style={{ padding: 0 }}>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Status</th><th>Name</th><th>Groups</th><th>Playlist</th><th>Now playing</th><th>Version</th><th>Last seen</th><th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((s) => (
                      <tr key={s.id}>
                        <td>
                          {statusOf(s) === 'unpaired' ? <span className="badge off">unpaired</span>
                            : statusOf(s) === 'online' ? <span className="badge ok"><StatusDot state="online" /> online</span>
                            : <span className="badge bad"><StatusDot state="offline" /> offline</span>}
                        </td>
                        <td><button className="crumb" title="Device health" onClick={() => setHealthId(s.id)}>{s.name}</button></td>
                        <td className="muted">{groupNames(s)}</td>
                        <td className="muted">{s.playlist_name ?? 'none assigned'}</td>
                        <td className="muted">{s.current_item ?? '-'}</td>
                        <td className="muted">{s.app_version ?? '-'}</td>
                        <td className="muted" title={s.last_seen_at ? new Date(s.last_seen_at).toLocaleString() : undefined}>{s.last_seen_at ? formatAgo(s.last_seen_at) : 'never'}</td>
                        <td style={{ textAlign: 'right' }}><Menu items={menuFor(s)} label={`Actions for ${s.name}`} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {pairOpen && (
        <Modal title="Pair a screen" onClose={() => setPairOpen(false)}
          actions={
            <>
              <button className="btn" onClick={() => setPairOpen(false)}>Cancel</button>
              <button type="submit" form="pair-form" className="btn btn-primary" disabled={code.length !== 6 || !name.trim() || pairing}>
                {pairing ? 'Pairing…' : 'Pair screen'}
              </button>
            </>
          }>
          <form id="pair-form" className="form-grid" onSubmit={(e) => { e.preventDefault(); if (code.length === 6 && name.trim()) void pair(); }}>
            <label className="form-field form-wide">
              <span>Pairing code (shown on the TV)</span>
              <input value={code} maxLength={6} autoComplete="off" style={{ letterSpacing: '0.3em', fontWeight: 700, textTransform: 'uppercase' }}
                onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABC123" />
            </label>
            <label className="form-field">
              <span>Screen name</span>
              <input value={name} placeholder="e.g. Reception" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="form-field">
              <span>Group (optional)</span>
              <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">No group</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
          </form>
        </Modal>
      )}

      {healthScreen && (
        <Modal wide onClose={() => setHealthId(null)}
          title={<>{healthScreen.name} <span className={`badge ${statusOf(healthScreen) === 'online' ? 'ok' : statusOf(healthScreen) === 'offline' ? 'bad' : 'off'}`}>{statusOf(healthScreen)}</span></>}
          actions={<button className="btn" onClick={() => setHealthId(null)}>Close</button>}>
          <div className="table-wrap">
            <table>
              <tbody>
                {healthRows(healthScreen).map(([label, value]) => (
                  <tr key={label}>
                    <td className="muted" style={{ width: 160 }}>{label}</td>
                    <td style={{ overflowWrap: 'anywhere' }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {shotScreen && (
        <Modal wide title={`${shotScreen.name} - screenshot`} onClose={() => setShotId(null)}
          actions={
            <>
              {canEdit && shotScreen.online && <button className="btn" onClick={() => void sendCommand(shotScreen, 'screenshot')}>Take a new one</button>}
              <button className="btn" onClick={() => setShotId(null)}>Close</button>
            </>
          }>
          {shotScreen.screenshot_url ? (
            <>
              <img src={shotScreen.screenshot_url} alt={`${shotScreen.name} screenshot`} style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)' }} />
              <div className="muted" style={{ marginTop: 8 }}>Captured {shotScreen.screenshot_at ? new Date(shotScreen.screenshot_at).toLocaleString() : '?'}</div>
            </>
          ) : (
            <div className="muted">Waiting for the screenshot to arrive… it appears here within a few seconds.</div>
          )}
        </Modal>
      )}

      {groupsScreen && (
        <Modal title={`Groups for ${groupsScreen.name}`} onClose={() => setGroupsEditId(null)}
          actions={<button className="btn btn-primary" onClick={() => setGroupsEditId(null)}>Done</button>}>
          {groups.length === 0 ? <div className="muted">No groups yet - add one from the Screens page.</div> : (
            <div style={{ display: 'grid', gap: 12 }}>
              {groups.map((g) => (
                <label key={g.id} className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                  <span>{g.name}</span>
                  <input type="checkbox" checked={groupsScreen.group_ids.includes(g.id)} onChange={(e) => void toggleGroup(groupsScreen, g.id, e.target.checked)} />
                </label>
              ))}
            </div>
          )}
        </Modal>
      )}

      {moveScreenRow && (
        <Modal title={`Move ${moveScreenRow.name}`} onClose={() => setMoveId(null)}
          actions={
            <>
              <button className="btn" onClick={() => setMoveId(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!moveTarget} onClick={() => void moveScreen(moveScreenRow)}>Move…</button>
            </>
          }>
          <label className="form-field">
            <span>Move to company</span>
            <select value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)}>
              <option value="">Choose…</option>
              {companies.filter((c) => c.id !== company.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </Modal>
      )}

      {rotateScreen && (
        <Modal title={`Rotation for ${rotateScreen.name}`} onClose={() => setRotateId(null)}
          actions={
            <>
              <button className="btn" onClick={() => setRotateId(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => void saveRotation(rotateScreen)}>Save</button>
            </>
          }>
          <label className="form-field">
            <span>Display rotation</span>
            <select value={rotation} onChange={(e) => setRotation(e.target.value)}>
              <option value="0">0° - landscape</option>
              <option value="90">90° - portrait</option>
              <option value="180">180° - landscape, flipped</option>
              <option value="270">270° - portrait, flipped</option>
            </select>
          </label>
        </Modal>
      )}
    </>
  );
}
