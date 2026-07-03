import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Company, MediaItem, Playlist, PlaylistItem } from '../types';

export function Playlists({ company, canEdit }: { company: Company; canEdit: boolean }) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<PlaylistItem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');

  const load = useCallback(async () => {
    const [p, m] = await Promise.all([
      api<Playlist[]>(`/api/companies/${company.id}/playlists`),
      api<MediaItem[]>(`/api/companies/${company.id}/media`),
    ]);
    setPlaylists(p);
    setMedia(m);
  }, [company.id]);

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : 'failed'));
  }, [load]);

  const openPlaylist = async (id: string) => {
    const data = await api<{ items: PlaylistItem[] }>(`/api/playlists/${id}`);
    setSelected(id);
    setItems(data.items);
    setDirty(false);
  };

  const saveItems = async () => {
    await api(`/api/playlists/${selected}/items`, {
      method: 'PUT',
      body: {
        items: items.map((i) => ({
          mediaId: i.media_id,
          url: i.url,
          durationMs: i.duration_ms,
          enabled: i.enabled,
          muted: i.muted,
        })),
      },
    });
    setDirty(false);
    await load();
  };

  const move = (index: number, dir: -1 | 1) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(index + dir, 0, item!);
    setItems(next);
    setDirty(true);
  };

  return (
    <>
      <h2>Playlists</h2>
      {error && <div className="error">{error}</div>}
      <div className="muted" style={{ marginBottom: 12 }}>
        Build playlists here, then put them on screens in the <strong>Schedule</strong> tab.
      </div>

      <div className="panel">
        {canEdit && (
          <div className="row" style={{ marginBottom: 12 }}>
            <input placeholder="New playlist name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button disabled={!newName}
              onClick={async () => {
                await api(`/api/companies/${company.id}/playlists`, { body: { name: newName } });
                setNewName('');
                await load();
              }}>
              Create playlist
            </button>
          </div>
        )}
        <table>
          <thead><tr><th>Name</th><th>Items</th><th></th></tr></thead>
          <tbody>
            {playlists.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="muted">{p.item_count}</td>
                <td>
                  <div className="row">
                    <button className="secondary" onClick={() => openPlaylist(p.id)}>Edit items</button>
                    {canEdit && (
                      <button className="secondary"
                        onClick={async () => {
                          const name = window.prompt('Rename playlist:', p.name);
                          if (name?.trim()) {
                            await api(`/api/playlists/${p.id}`, { method: 'PATCH', body: { name: name.trim() } });
                            await load();
                          }
                        }}>
                        Rename
                      </button>
                    )}
                    {canEdit && (
                      <button className="danger"
                        onClick={async () => {
                          if (confirm(`Delete playlist "${p.name}"?`)) {
                            if (selected === p.id) setSelected(null);
                            await api(`/api/playlists/${p.id}`, { method: 'DELETE' });
                            await load();
                          }
                        }}>
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {playlists.length === 0 && <tr><td colSpan={3} className="muted">No playlists yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="panel">
          <div className="row spread" style={{ marginBottom: 8 }}>
            <strong>{playlists.find((p) => p.id === selected)?.name} - items</strong>
            {canEdit && <button onClick={saveItems} disabled={!dirty}>Save changes</button>}
          </div>
          {canEdit && (
            <div className="row" style={{ marginBottom: 12 }}>
              <select id="add-media" defaultValue="">
                <option value="" disabled>Add media…</option>
                {media.map((m) => (
                  <option key={m.id} value={m.id}>{m.original_name}</option>
                ))}
              </select>
              <button className="secondary"
                onClick={() => {
                  const select = document.getElementById('add-media') as HTMLSelectElement;
                  const chosen = media.find((m) => m.id === select.value);
                  if (!chosen) return;
                  setItems([...items, {
                    media_id: chosen.id, url: null,
                    duration_ms: chosen.kind === 'image' ? 10000 : null,
                    enabled: true, muted: false,
                    original_name: chosen.original_name, kind: chosen.kind,
                  }]);
                  setDirty(true);
                  select.value = '';
                }}>
                Add
              </button>
              <span className="muted">or</span>
              <input placeholder="https:// web page or live stream (.m3u8/.mpd)" value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)} style={{ minWidth: 260 }} />
              <button className="secondary" disabled={!newUrl.startsWith('http')}
                onClick={() => {
                  setItems([...items, {
                    media_id: null, url: newUrl.trim(),
                    duration_ms: 30000, // web pages need an explicit duration; default 30s
                    enabled: true, muted: false, kind: 'url',
                  }]);
                  setNewUrl('');
                  setDirty(true);
                }}>
                Add URL
              </button>
            </div>
          )}
          <table>
            <thead><tr><th>#</th><th>Item</th><th>Duration</th><th>Enabled</th><th>Muted</th>{canEdit && <th></th>}</tr></thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={index}>
                  <td className="muted">{index + 1}</td>
                  <td>{item.original_name ?? item.url ?? item.media_id}</td>
                  <td>
                    {canEdit ? (
                      <input type="number" style={{ width: 90 }} min={1}
                        value={item.duration_ms != null ? item.duration_ms / 1000 : ''}
                        placeholder={item.kind === 'video' ? 'auto' : '10'}
                        onChange={(e) => {
                          const next = [...items];
                          next[index] = {
                            ...item,
                            duration_ms: e.target.value ? Number(e.target.value) * 1000 : null,
                          };
                          setItems(next);
                          setDirty(true);
                        }} />
                    ) : (
                      <span className="muted">{item.duration_ms ? `${item.duration_ms / 1000}s` : 'auto'}</span>
                    )}
                  </td>
                  <td>
                    <input type="checkbox" checked={item.enabled} disabled={!canEdit}
                      onChange={(e) => {
                        const next = [...items];
                        next[index] = { ...item, enabled: e.target.checked };
                        setItems(next);
                        setDirty(true);
                      }} />
                  </td>
                  <td>
                    {item.kind === 'video' ? (
                      <input type="checkbox" checked={item.muted} disabled={!canEdit}
                        onChange={(e) => {
                          const next = [...items];
                          next[index] = { ...item, muted: e.target.checked };
                          setItems(next);
                          setDirty(true);
                        }} />
                    ) : (
                      <span className="muted"> - </span>
                    )}
                  </td>
                  {canEdit && (
                    <td>
                      <div className="row">
                        <button className="secondary" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
                        <button className="secondary" disabled={index === items.length - 1} onClick={() => move(index, 1)}>↓</button>
                        <button className="danger"
                          onClick={() => {
                            setItems(items.filter((_, i) => i !== index));
                            setDirty(true);
                          }}>
                          ✕
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={6} className="muted">Empty playlist - add media above.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
