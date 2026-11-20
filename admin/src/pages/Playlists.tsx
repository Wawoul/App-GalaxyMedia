import { useCallback, useEffect, useRef, useState } from 'react';
import { useUi } from '../components/ui';
import { api, ApiError } from '../api';
import { LibraryPicker } from '../components/library';
import type { Company, MediaItem, Playlist, PlaylistItem } from '../types';
import './playlists.css';

/** Plain-English reasons for the few ways saving a playlist can be refused. */
function saveError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.message === 'media_not_in_company') {
      return 'A file in this playlist was replaced or deleted since you opened it (for example a slide was re-saved). Reload the playlist and try again.';
    }
    if (err.message === 'forbidden') return "You don't have permission to change this playlist.";
    return err.message;
  }
  return err instanceof Error ? err.message : 'Could not save the playlist';
}

/** Same rule the players use to decide an item is a live stream. */
const isStreamUrl = (url: string) => {
  const path = url.split('?')[0]!.toLowerCase();
  return path.endsWith('.m3u8') || path.endsWith('.mpd');
};

/** "3600" in a seconds field doesn't read as an hour; this spells it out. */
function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = seconds / 60;
  if (seconds % 60 === 0 && minutes < 60) return `${minutes} min`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hr`;
  if (minutes < 60) return `${Math.floor(minutes)} min ${seconds % 60} sec`;
  return `${Math.floor(seconds / 3600)} hr ${Math.round((seconds % 3600) / 60)} min`;
}

export function Playlists({ company, canEdit }: { company: Company; canEdit: boolean }) {
  const ui = useUi();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  // media id -> design id, so slides made in the designer can be reopened from here.
  const [designs, setDesigns] = useState<Record<string, string>>({});
  // A live slide (widgets/animation) sits in a playlist as a web-page item; its link identifies it.
  const [liveDesigns, setLiveDesigns] = useState<Record<string, { id: string; media_id: string | null; name: string }>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<PlaylistItem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [picking, setPicking] = useState(false);
  // "#/playlists?open=<id>" - the designer sends you back to the playlist you came from.
  const openOnLoad = useRef(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('open'));

  const load = useCallback(async () => {
    const [p, m, d] = await Promise.all([
      api<Playlist[]>(`/api/companies/${company.id}/playlists`),
      api<MediaItem[]>(`/api/companies/${company.id}/media`),
      api<{ id: string; media_id: string | null; name: string; live_url?: string }[]>(`/api/companies/${company.id}/designs`).catch(() => []),
    ]);
    setPlaylists(p);
    setMedia(m);
    setDesigns(Object.fromEntries(d.flatMap((x) => (x.media_id && !x.live_url ? [[x.media_id, x.id]] : []))));
    setLiveDesigns(Object.fromEntries(d.flatMap((x) => (x.live_url ? [[x.live_url, { id: x.id, media_id: x.media_id, name: x.name }]] : []))));
  }, [company.id]);

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : 'failed'));
  }, [load]);

  // Same protection for closing the tab or hitting back mid-edit.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const openPlaylist = async (id: string) => {
    if (id === selected) return;
    // Switching playlists replaced `items` outright, silently throwing away an
    // in-progress reorder or duration edit with no way to get it back.
    if (dirty && !await ui.ask('Discard unsaved changes to the current playlist?')) return;
    const data = await api<{ items: PlaylistItem[] }>(`/api/playlists/${id}`);
    setSelected(id);
    setItems(data.items);
    setDirty(false);
  };

  useEffect(() => {
    const id = openOnLoad.current;
    if (!id) return;
    openOnLoad.current = null;
    void openPlaylist(id).catch(() => undefined);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  /** Save with feedback: a refused save used to vanish silently (the click handler had no catch). */
  const saveClicked = async () => {
    try {
      await saveItems();
      ui.toast('Playlist saved', 'ok');
    } catch (err) {
      ui.toast(saveError(err), 'error');
    }
  };

  const addFromLibrary = (picked: MediaItem[]) => {
    setItems((cur) => [...cur, ...picked.map((m): PlaylistItem => ({
      media_id: m.id, url: null,
      duration_ms: m.kind === 'image' ? 10000 : null,
      enabled: true, muted: false,
      original_name: m.original_name, kind: m.kind,
    }))]);
    setDirty(true);
    setPicking(false);
  };

  /** Clone a designed slide and append the copy to this playlist. */
  const duplicateSlide = async (designId: string) => {
    if (dirty) {
      if (!(await ui.ask('Save your playlist changes first?', { confirmLabel: 'Save and continue' }))) return;
      try { await saveItems(); } catch (err) { ui.toast(saveError(err), 'error'); return; }
    }
    try {
      await api(`/api/designs/${designId}/duplicate`, { body: { playlistId: selected } });
      const data = await api<{ items: PlaylistItem[] }>(`/api/playlists/${selected}`);
      setItems(data.items);
      await load();
      ui.toast('Slide duplicated and added to the end of the playlist', 'ok');
    } catch (err) {
      ui.toast(saveError(err), 'error');
    }
  };

  const move = (index: number, dir: -1 | 1) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(index + dir, 0, item!);
    setItems(next);
    setDirty(true);
  };

  const patchItem = (index: number, patch: Partial<PlaylistItem>) => {
    const next = [...items];
    next[index] = { ...next[index]!, ...patch };
    setItems(next);
    setDirty(true);
  };

  /** Opens the slide designer for this playlist. Unsaved list edits are saved first, so nothing is lost. */
  const openDesigner = async (designId: string | 'new') => {
    if (dirty) {
      if (!(await ui.ask('Save your playlist changes first? The designer opens as a full screen.', { confirmLabel: 'Save and continue' }))) return;
      try {
        await saveItems();
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : 'Could not save the playlist', 'error');
        return;
      }
    }
    window.location.hash = `#/designer/${designId}?playlist=${selected}`;
  };

  const selectedPlaylist = playlists.find((p) => p.id === selected);
  const knownMs = items.reduce((sum, i) => sum + (i.enabled && i.duration_ms ? i.duration_ms : 0), 0);
  const hasVideo = items.some((i) => i.enabled && i.kind === 'video' && !i.duration_ms);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Playlists</h2>
          <div className="page-sub">Build playlists here, then put them on screens in the <strong>Schedule</strong> tab.</div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

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
        <div className="table-wrap"><table>
          <thead><tr><th>Name</th><th>Items</th><th></th></tr></thead>
          <tbody>
            {playlists.map((p) => (
              <tr key={p.id} className={p.id === selected ? 'row-active' : undefined}>
                <td>{p.name}</td>
                <td className="muted">{p.item_count}</td>
                <td>
                  <div className="row">
                    <button className="secondary" onClick={() => openPlaylist(p.id)}>Edit items</button>
                    {canEdit && (
                      <button className="secondary"
                        onClick={async () => {
                          const name = await ui.input('Rename playlist:', p.name);
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
                          // Say what the delete takes with it before asking.
                          let warning = '';
                          try {
                            const u = await api<{ assignments: number; layouts: number }>(`/api/playlists/${p.id}/usage`);
                            const parts = [
                              u.assignments > 0 && `${u.assignments} schedule slot${u.assignments === 1 ? '' : 's'} (they will be removed)`,
                              u.layouts > 0 && `${u.layouts} layout${u.layouts === 1 ? '' : 's'} (that zone will be left empty)`,
                            ].filter(Boolean);
                            if (parts.length) warning = `\n\nIt is in use by ${parts.join(' and ')}.`;
                          } catch {
                            /* the plain confirm below still protects against a misclick */
                          }
                          if (await ui.ask(`Delete playlist "${p.name}"?${warning}`)) {
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
        </table></div>
      </div>

      {selected && (
        <div className="panel">
          <div className="pl-head">
            <div>
              <h3>{selectedPlaylist?.name}</h3>
              <div className="muted">
                {items.length} item{items.length === 1 ? '' : 's'}
                {knownMs > 0 && ` · ${humanDuration(knownMs)}${hasVideo ? ' + videos' : ''} per loop`}
              </div>
            </div>
            {canEdit && (
              <div className="row">
                <button className="btn" onClick={() => void openDesigner('new')}
                  title="Design a slide with text, shapes and images and add it to this playlist">
                  ✎ Design a slide
                </button>
                <button className="btn btn-primary" onClick={() => void saveClicked()} disabled={!dirty}>Save changes</button>
              </div>
            )}
          </div>

          {canEdit && (
            <div className="row" style={{ marginBottom: 14 }}>
              <button className="btn" onClick={() => setPicking(true)}
                title="Choose images and videos from your library">
                ＋ Add from library
              </button>
              <span className="muted">or</span>
              <input placeholder="https:// web page or live stream (.m3u8/.mpd)" value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)} style={{ minWidth: 260 }} />
              <button className="secondary" disabled={!newUrl.startsWith('http')}
                onClick={() => {
                  const url = newUrl.trim();
                  setItems([...items, {
                    media_id: null, url,
                    // Web pages need an explicit duration (30s). For a live
                    // stream the value is a restart interval, not a stop time,
                    // so 30s would needlessly re-buffer the feed twice a minute -
                    // an hour matches the players' own default.
                    duration_ms: isStreamUrl(url) ? 3_600_000 : 30_000,
                    enabled: true, muted: false, kind: 'url',
                  }]);
                  setNewUrl('');
                  setDirty(true);
                }}>
                Add URL
              </button>
            </div>
          )}

          {items.length === 0 ? (
            <div className="pl-empty">
              <b>This playlist is empty</b>
              <span>Add media or a web page above{canEdit ? ', or design a slide from scratch.' : '.'}</span>
              {canEdit && <button className="btn btn-primary" onClick={() => void openDesigner('new')}>✎ Design a slide</button>}
            </div>
          ) : (
            <ol className="pl-items">
              {items.map((item, index) => {
                const live = item.url ? liveDesigns[item.url] : undefined;
                // A live slide shows its rendered picture as the thumbnail, like any other slide.
                const m = item.media_id ? media.find((x) => x.id === item.media_id) : live?.media_id ? media.find((x) => x.id === live.media_id) : undefined;
                const designId = live?.id ?? (item.media_id ? designs[item.media_id] : undefined);
                return (
                  // Keyed by identity, not index: the move buttons below reorder
                  // this list, and an index key makes React reuse the DOM node for
                  // a different item - so a focused duration input keeps its old
                  // value while now belonging to another row.
                  <li key={item.id ?? `${item.media_id ?? item.url}-${index}`} className={item.enabled ? undefined : 'off'}>
                    <span className="pl-num">{index + 1}</span>
                    <div className="pl-thumb" aria-hidden="true">
                      {m?.kind === 'image' ? <img src={m.url} alt="" loading="lazy" />
                        : item.url ? <span>🔗</span> : <span>▶</span>}
                    </div>
                    <div className="pl-main">
                      <div className="pl-name">
                        <span title={live?.name ?? item.original_name ?? item.url ?? undefined}>{live?.name ?? item.original_name ?? item.url ?? item.media_id}</span>
                        {designId && <span className={`badge ${live ? 'live' : 'ok'}`} title={live ? 'Widgets or animation: plays from the server, so the TV must be online' : undefined}>{live ? 'Live slide' : 'Designed slide'}</span>}
                      </div>
                      <div className="pl-dur">
                        {canEdit ? (
                          <label>
                            <input type="number" min={1}
                              value={item.duration_ms != null ? item.duration_ms / 1000 : ''}
                              placeholder={item.kind === 'video' ? 'auto' : '10'}
                              aria-label={`Duration in seconds for item ${index + 1}`}
                              onChange={(e) => {
                                const seconds = Number(e.target.value);
                                // A negative or non-numeric duration reaches the player
                                // as a non-positive setTimeout, which fires instantly
                                // and spins the playlist. Blank stays "auto" (null).
                                const valid = e.target.value !== '' && Number.isFinite(seconds) && seconds > 0;
                                patchItem(index, { duration_ms: valid ? Math.round(seconds * 1000) : null });
                              }} />
                            {/* Spell the value back out: "3600" in a seconds field is hard to read as an hour,
                                and "1" is easy to mistake for a sensible default when it means one second. */}
                            <span className="muted"> seconds{item.duration_ms ? ` · ${humanDuration(item.duration_ms)}` : ''}
                              {item.url && isStreamUrl(item.url) ? ' · restart interval' : ''}</span>
                          </label>
                        ) : (
                          <span className="muted">{item.duration_ms ? humanDuration(item.duration_ms) : 'auto'}</span>
                        )}
                      </div>
                      {/* A stream restarting every few seconds just re-buffers forever and looks broken -
                          the most likely way this field gets set wrong. */}
                      {item.url && isStreamUrl(item.url) && item.duration_ms != null && item.duration_ms < 60_000 && (
                        <div className="error" style={{ fontSize: 12, marginTop: 4 }}>
                          Restarts every {humanDuration(item.duration_ms)} - the stream will keep
                          re-buffering. Use 3600 (1 hr) unless you have a reason not to.
                        </div>
                      )}
                    </div>
                    <div className="pl-opts">
                      <label className="pl-check"><input type="checkbox" checked={item.enabled} disabled={!canEdit}
                        onChange={(e) => patchItem(index, { enabled: e.target.checked })} /> On</label>
                      {item.kind === 'video' && (
                        <label className="pl-check"><input type="checkbox" checked={item.muted} disabled={!canEdit}
                          onChange={(e) => patchItem(index, { muted: e.target.checked })} /> Muted</label>
                      )}
                    </div>
                    {canEdit && (
                      <div className="pl-actions">
                        {designId && <button className="btn btn-sm" onClick={() => void openDesigner(designId)}>Edit design</button>}
                        {designId && <button className="btn btn-sm" onClick={() => void duplicateSlide(designId)} title="Copy this slide and add the copy to the end of the playlist">Duplicate</button>}
                        <button className="secondary" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
                        <button className="secondary" aria-label="Move down" disabled={index === items.length - 1} onClick={() => move(index, 1)}>↓</button>
                        <button className="danger" aria-label="Remove from playlist"
                          onClick={() => {
                            setItems(items.filter((_, i) => i !== index));
                            setDirty(true);
                          }}>
                          ✕
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}

      {picking && <LibraryPicker companyId={company.id} onAdd={addFromLibrary} onClose={() => setPicking(false)} />}
    </>
  );
}
