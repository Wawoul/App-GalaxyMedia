import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Company, Group, Screen } from '../types';

function formatUptime(s: number): string {
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
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
    ['IP address', s.ip ?? '-'],
    ['App version', s.app_version ?? '-'],
    ['Last seen', s.last_seen_at ? new Date(s.last_seen_at).toLocaleString() : 'never'],
  ];
}

export function Screens({
  company,
  companies,
  canEdit,
}: {
  company: Company;
  companies: Company[];
  canEdit: boolean;
}) {
  const [screens, setScreens] = useState<Screen[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState('');
  // pairing form
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [newGroup, setNewGroup] = useState('');
  // row-level editors
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [groupsEditId, setGroupsEditId] = useState<string | null>(null);
  const [shotId, setShotId] = useState<string | null>(null); // screenshot viewer row
  const [healthId, setHealthId] = useState<string | null>(null); // device-health popup
  // list controls
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'status' | 'last_seen'>('name');
  const [filterGroup, setFilterGroup] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, g] = await Promise.all([
        api<Screen[]>(`/api/screens?companyId=${company.id}`),
        api<Group[]>(`/api/companies/${company.id}/groups`),
      ]);
      setScreens(s);
      setGroups(g);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }, [company.id]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 15000); // keep online status fresh
    return () => clearInterval(timer);
  }, [load]);

  const pair = async () => {
    setError('');
    try {
      await api('/api/screens/pair', {
        body: { code: code.toUpperCase(), companyId: company.id, name, groupIds: groupId ? [groupId] : [] },
      });
      setCode('');
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  };

  const createGroup = async () => {
    await api(`/api/companies/${company.id}/groups`, { body: { name: newGroup } });
    setNewGroup('');
    await load();
  };

  const runAction = async (screen: Screen, action: string) => {
    setError('');
    try {
      switch (action) {
        case 'identify':
        case 'reload':
        case 'screenshot': {
          if (!screen.online) {
            setError(`"${screen.name}" is offline - it can't receive commands right now.`);
            break;
          }
          const cmd = await api<{ ok: boolean; delivered: boolean }>(
            `/api/screens/${screen.id}/command`,
            { body: { command: action } },
          );
          if (!cmd.delivered) {
            setError(`"${screen.name}" didn't receive the command - it may have just gone offline.`);
            break;
          }
          if (action === 'screenshot') {
            setShotId(screen.id);
            setTimeout(() => void load(), 4000); // give the TV a moment to upload
          }
          break;
        }
        case 'health':
          setHealthId(screen.id);
          break;
        case 'view_shot':
          setShotId(shotId === screen.id ? null : screen.id);
          break;
        case 'rename': {
          const next = window.prompt('New screen name:', screen.name);
          if (next?.trim()) {
            await api(`/api/screens/${screen.id}`, { method: 'PATCH', body: { name: next.trim() } });
            await load();
          }
          break;
        }
        case 'rotate': {
          const next = window.prompt(
            'Display rotation in degrees - 0 (landscape), 90 (portrait), 180 (flipped), 270 (portrait flipped):',
            String(screen.orientation ?? 0),
          );
          if (next !== null) {
            const deg = Number(next.trim());
            if ([0, 90, 180, 270].includes(deg)) {
              await api(`/api/screens/${screen.id}`, { method: 'PATCH', body: { orientation: deg } });
              await load();
            } else {
              setError('Rotation must be 0, 90, 180 or 270');
            }
          }
          break;
        }
        case 'groups':
          setGroupsEditId(groupsEditId === screen.id ? null : screen.id);
          setMovingId(null);
          break;
        case 'move':
          setMovingId(movingId === screen.id ? null : screen.id);
          setMoveTarget('');
          setGroupsEditId(null);
          break;
        case 'unpair':
          if (confirm(`Unpair "${screen.name}"? The TV returns to its pairing screen.`)) {
            await api(`/api/screens/${screen.id}/unpair`, { body: {} });
            await load();
          }
          break;
        case 'delete':
          if (confirm(`Delete "${screen.name}" completely? The TV will show its pairing screen again.`)) {
            await api(`/api/screens/${screen.id}`, { method: 'DELETE' });
            await load();
          }
          break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  };

  const toggleGroup = async (screen: Screen, gid: string, on: boolean) => {
    const next = on ? [...screen.group_ids, gid] : screen.group_ids.filter((x) => x !== gid);
    await api(`/api/screens/${screen.id}`, { method: 'PATCH', body: { groupIds: next } });
    await load();
  };

  const moveScreen = async (screen: Screen) => {
    if (!moveTarget) return;
    const target = companies.find((c) => c.id === moveTarget);
    if (
      confirm(
        `Move "${screen.name}" to ${target?.name}? Its group memberships and direct assignments are removed; the TV will switch to that company's content.`,
      )
    ) {
      await api(`/api/screens/${screen.id}/move`, { body: { companyId: moveTarget } });
      setMovingId(null);
      await load();
    }
  };

  const query = search.trim().toLowerCase();
  const visible = screens
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
  const healthScreen = healthId ? screens.find((s) => s.id === healthId) : null;

  return (
    <>
      <h2>Screens</h2>

      {canEdit && (
        <div className="panel">
          <div className="row">
            <input placeholder="Pairing code (on the TV)" value={code} maxLength={6}
              onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ width: 170 }} />
            <input placeholder="Screen name (e.g. Reception)" value={name} onChange={(e) => setName(e.target.value)} />
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">No group</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <button onClick={pair} disabled={code.length !== 6 || !name}>Pair screen</button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <input placeholder="New group name" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
            <button className="secondary" onClick={createGroup} disabled={!newGroup}>Add group</button>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="panel">
        <div className="row" style={{ marginBottom: 12 }}>
          <input placeholder="Search screens…" value={search} onChange={(e) => setSearch(e.target.value)}
            style={{ width: 220 }} />
          <select value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)}>
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
            <option value="name">Sort: Name</option>
            <option value="status">Sort: Status (offline first)</option>
            <option value="last_seen">Sort: Last seen</option>
          </select>
          {(search || filterGroup) && (
            <span className="muted">{visible.length} of {screens.length} screens</span>
          )}
        </div>
        <table>
          <thead>
            <tr>
              <th>Status</th><th>Name</th><th>Groups</th><th>Playlist</th><th>Now playing</th><th>Version</th><th>Last seen</th>
              {canEdit && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => [
              <tr key={s.id}>
                <td>
                  {!s.paired ? <span className="badge off">unpaired</span>
                    : s.online ? <span className="badge ok">online</span>
                    : <span className="badge bad">offline</span>}
                </td>
                <td>
                  <span className="crumb" title="Device health" onClick={() => setHealthId(s.id)}>{s.name}</span>
                </td>
                <td className="muted">
                  {groupsEditId === s.id ? (
                    <div className="row">
                      {groups.length === 0 && <span>No groups yet</span>}
                      {groups.map((g) => (
                        <label key={g.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <input type="checkbox" checked={s.group_ids.includes(g.id)}
                            onChange={(e) => toggleGroup(s, g.id, e.target.checked)} />
                          {g.name}
                        </label>
                      ))}
                    </div>
                  ) : (
                    s.group_ids.map((id) => groups.find((g) => g.id === id)?.name).filter(Boolean).join(', ') || ' - '
                  )}
                </td>
                <td className="muted">{s.playlist_name ?? 'none assigned'}</td>
                <td className="muted">{s.current_item ?? ' - '}</td>
                <td className="muted">{s.app_version ?? ' - '}</td>
                <td className="muted">{s.last_seen_at ? new Date(s.last_seen_at).toLocaleString() : 'never'}</td>
                {canEdit && (
                  <td>
                    {movingId === s.id ? (
                      <div className="row">
                        <select value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)}>
                          <option value="">Move to…</option>
                          {companies.filter((c) => c.id !== company.id).map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                        <button onClick={() => moveScreen(s)} disabled={!moveTarget}>Move</button>
                        <button className="secondary" onClick={() => setMovingId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <select value="" onChange={(e) => runAction(s, e.target.value)}>
                        <option value="" disabled>Actions…</option>
                        <option value="health">Device health…</option>
                        <option value="identify">Identify (flash name on TV)</option>
                        <option value="reload">Reload content</option>
                        <option value="screenshot">Take screenshot</option>
                        {s.screenshot_url && <option value="view_shot">{shotId === s.id ? 'Hide screenshot' : 'View screenshot'}</option>}
                        <option value="rename">Rename</option>
                        <option value="rotate">Set rotation (portrait/flipped)</option>
                        <option value="groups">{groupsEditId === s.id ? 'Done editing groups' : 'Edit groups'}</option>
                        {companies.length > 1 && <option value="move">Move to another company</option>}
                        <option value="unpair">Unpair</option>
                        <option value="delete">Delete</option>
                      </select>
                    )}
                  </td>
                )}
              </tr>,
              shotId === s.id && s.screenshot_url && (
                <tr key={`${s.id}-shot`}>
                  <td colSpan={8} style={{ background: 'var(--panel2)' }}>
                    <div className="row">
                      <img src={s.screenshot_url} alt={`${s.name} screenshot`}
                        style={{ maxWidth: 480, borderRadius: 6, border: '1px solid var(--border)' }} />
                      <div className="muted">
                        Captured {s.screenshot_at ? new Date(s.screenshot_at).toLocaleString() : '?'}
                        <br />
                        Use "Take screenshot" for a fresh one.
                      </div>
                    </div>
                  </td>
                </tr>
              ),
            ])}
            {visible.length === 0 && (
              <tr><td colSpan={8} className="muted">
                {screens.length === 0
                  ? 'No screens yet - pair a TV with its on-screen code.'
                  : 'No screens match the current search/filter.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {healthScreen && (
        <div className="modal-backdrop" onClick={() => setHealthId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              {healthScreen.name}
              {healthScreen.online
                ? <span className="badge ok" style={{ marginLeft: 10 }}>online</span>
                : <span className="badge bad" style={{ marginLeft: 10 }}>offline</span>}
            </div>
            <table>
              <tbody>
                {healthRows(healthScreen).map(([label, value]) => (
                  <tr key={label}>
                    <td className="muted" style={{ width: 140 }}>{label}</td>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setHealthId(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
