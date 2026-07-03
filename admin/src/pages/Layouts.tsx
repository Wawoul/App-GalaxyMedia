import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Company, CustomZone, Layout, LayoutPreset, Playlist } from '../types';

const PRESETS: { id: LayoutPreset; label: string; needsSide: boolean; needsTicker: boolean }[] = [
  { id: 'main-side', label: 'Main + sidebar', needsSide: true, needsTicker: false },
  { id: 'main-ticker', label: 'Main + ticker', needsSide: false, needsTicker: true },
  { id: 'main-side-ticker', label: 'Main + sidebar + ticker', needsSide: true, needsTicker: true },
  { id: 'split-2', label: 'Split 50/50', needsSide: true, needsTicker: false },
  { id: 'custom', label: 'Custom zones', needsSide: false, needsTicker: false },
];

/** Tiny wireframe preview of a preset (custom draws its live zones). */
function PresetPreview({
  preset,
  active,
  customZones,
}: {
  preset: LayoutPreset;
  active: boolean;
  customZones?: CustomZone[];
}) {
  const stroke = active ? 'var(--accent)' : 'var(--border)';
  const zone = { fill: 'var(--panel2)', stroke, strokeWidth: 2 } as const;
  return (
    <svg width="96" height="56" viewBox="0 0 96 56">
      {preset === 'main-side' && (<>
        <rect x="1" y="1" width="70" height="54" {...zone} />
        <rect x="73" y="1" width="22" height="54" {...zone} />
      </>)}
      {preset === 'main-ticker' && (<>
        <rect x="1" y="1" width="94" height="46" {...zone} />
        <rect x="1" y="49" width="94" height="6" {...zone} />
      </>)}
      {preset === 'main-side-ticker' && (<>
        <rect x="1" y="1" width="70" height="46" {...zone} />
        <rect x="73" y="1" width="22" height="46" {...zone} />
        <rect x="1" y="49" width="94" height="6" {...zone} />
      </>)}
      {preset === 'split-2' && (<>
        <rect x="1" y="1" width="46" height="54" {...zone} />
        <rect x="49" y="1" width="46" height="54" {...zone} />
      </>)}
      {preset === 'custom' && (
        (customZones?.length ? customZones : [{ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }]).map((z, i) => (
          <rect key={i} x={1 + z.x * 94} y={1 + z.y * 54} width={z.w * 94} height={z.h * 54} {...zone} />
        ))
      )}
    </svg>
  );
}

export function Layouts({ company, canEdit }: { company: Company; canEdit: boolean }) {
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  // create form
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<LayoutPreset>('main-side');
  const [mainPlaylist, setMainPlaylist] = useState('');
  const [sidePlaylist, setSidePlaylist] = useState('');
  const [tickerText, setTickerText] = useState('');
  const [customZones, setCustomZones] = useState<(CustomZone & { tickerRaw?: string })[]>([
    { x: 0, y: 0, w: 1, h: 1, playlistId: null },
  ]);

  const load = useCallback(async () => {
    const [l, p] = await Promise.all([
      api<Layout[]>(`/api/companies/${company.id}/layouts`),
      api<Playlist[]>(`/api/companies/${company.id}/playlists`),
    ]);
    setLayouts(l);
    setPlaylists(p);
  }, [company.id]);

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : 'failed'));
  }, [load]);

  const config = PRESETS.find((p) => p.id === preset)!;
  const playlistName = (id?: string | null) => playlists.find((p) => p.id === id)?.name ?? '?';

  const create = async () => {
    setError('');
    try {
      const zones =
        preset === 'custom'
          ? {
              custom: customZones.map((zone) => ({
                x: zone.x, y: zone.y, w: zone.w, h: zone.h,
                playlistId: zone.playlistId || null,
                tickerTexts: zone.tickerRaw
                  ? zone.tickerRaw.split('|').map((t) => t.trim()).filter(Boolean)
                  : null,
              })),
            }
          : {
              main: mainPlaylist,
              side: config.needsSide ? sidePlaylist : null,
              ticker: config.needsTicker
                ? { texts: tickerText.split('\n').map((t) => t.trim()).filter(Boolean) }
                : null,
            };
      await api(`/api/companies/${company.id}/layouts`, { body: { name, preset, zones } });
      setName(''); setMainPlaylist(''); setSidePlaylist(''); setTickerText('');
      setCustomZones([{ x: 0, y: 0, w: 1, h: 1, playlistId: null }]);
      setShowCreate(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  };

  const setZone = (index: number, patch: Partial<CustomZone & { tickerRaw?: string }>) => {
    setCustomZones(customZones.map((zone, i) => (i === index ? { ...zone, ...patch } : zone)));
  };
  const pct = (value: number) => Math.round(value * 100);
  const fromPct = (value: string) => Math.min(1, Math.max(0, Number(value) / 100));

  return (
    <>
      <div className="row spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Layouts</h2>
        {canEdit && (
          <button onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Close' : '+ New layout'}</button>
        )}
      </div>
      <div className="muted" style={{ marginBottom: 12 }}>
        Split the screen into zones, each playing its own playlist. Put a layout on screens in
        the Schedule tab, same as a playlist.
      </div>

      {showCreate && (
        <div className="panel">
          <div className="row" style={{ marginBottom: 12 }}>
            {PRESETS.map((p) => (
              <button key={p.id} type="button" className="secondary"
                style={{
                  display: 'grid', gap: 4, justifyItems: 'center', padding: 10,
                  borderColor: preset === p.id ? 'var(--accent)' : 'var(--border)',
                }}
                onClick={() => setPreset(p.id)}>
                <PresetPreview preset={p.id} active={preset === p.id}
                  customZones={p.id === 'custom' ? customZones : undefined} />
                <span style={{ fontSize: 12 }}>{p.label}</span>
              </button>
            ))}
          </div>
          <div className="form-grid" style={{ maxWidth: 700 }}>
            <label className="form-field">
              <span>Layout name</span>
              <input value={name} placeholder="e.g. Menu + promos" onChange={(e) => setName(e.target.value)} />
            </label>
            {preset !== 'custom' && (
            <label className="form-field">
              <span>Main zone playlist</span>
              <select value={mainPlaylist} onChange={(e) => setMainPlaylist(e.target.value)}>
                <option value="">Choose…</option>
                {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            )}
            {config.needsSide && (
              <label className="form-field">
                <span>Side zone playlist</span>
                <select value={sidePlaylist} onChange={(e) => setSidePlaylist(e.target.value)}>
                  <option value="">Choose…</option>
                  {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
            {config.needsTicker && (
              <label className="form-field form-wide">
                <span>Ticker lines (one per line, scroll in a loop)</span>
                <textarea rows={3} value={tickerText} onChange={(e) => setTickerText(e.target.value)}
                  placeholder={'Welcome to our store\nFollow us @example'}
                  style={{ background: 'var(--panel2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }} />
              </label>
            )}
          </div>

          {preset === 'custom' && (
            <div style={{ marginTop: 12 }}>
              <div className="muted" style={{ marginBottom: 8 }}>
                Position and size are percentages of the screen (X/Y = top-left corner).
                Up to 6 zones; each plays a playlist or scrolls ticker text.
              </div>
              {customZones.map((zone, index) => (
                <div key={index} className="row" style={{ marginBottom: 8 }}>
                  <span className="muted">Zone {index + 1}</span>
                  {(['x', 'y', 'w', 'h'] as const).map((axis) => (
                    <label key={axis} className="row" style={{ gap: 4 }}>
                      <span className="muted">{axis.toUpperCase()}</span>
                      <input type="number" min={0} max={100} value={pct(zone[axis])} style={{ width: 64 }}
                        onChange={(e) => setZone(index, { [axis]: fromPct(e.target.value) })} />
                      <span className="muted">%</span>
                    </label>
                  ))}
                  <select value={zone.tickerRaw != null ? 'ticker' : (zone.playlistId ?? '')}
                    onChange={(e) => {
                      if (e.target.value === 'ticker') setZone(index, { playlistId: null, tickerRaw: '' });
                      else setZone(index, { playlistId: e.target.value || null, tickerRaw: undefined });
                    }}>
                    <option value="">Playlist…</option>
                    {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    <option value="ticker">Ticker text</option>
                  </select>
                  {zone.tickerRaw != null && (
                    <input placeholder="Ticker lines (use | between lines)" value={zone.tickerRaw}
                      style={{ minWidth: 220 }}
                      onChange={(e) => setZone(index, { tickerRaw: e.target.value })} />
                  )}
                  <button className="danger" disabled={customZones.length === 1}
                    onClick={() => setCustomZones(customZones.filter((_, i) => i !== index))}>
                    ✕
                  </button>
                </div>
              ))}
              <button className="secondary" disabled={customZones.length >= 6}
                onClick={() => setCustomZones([...customZones, { x: 0.5, y: 0.5, w: 0.5, h: 0.5, playlistId: null }])}>
                + Add zone
              </button>
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={create}
              disabled={
                !name ||
                (preset === 'custom'
                  ? customZones.some((zone) => !zone.playlistId && !zone.tickerRaw?.trim())
                  : !mainPlaylist ||
                    (config.needsSide && !sidePlaylist) ||
                    (config.needsTicker && !tickerText.trim()))
              }>
              Create layout
            </button>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="panel">
        <table>
          <thead><tr><th></th><th>Name</th><th>Zones</th>{canEdit && <th></th>}</tr></thead>
          <tbody>
            {layouts.map((l) => (
              <tr key={l.id}>
                <td><PresetPreview preset={l.preset} active={false} customZones={l.zones.custom ?? undefined} /></td>
                <td>{l.name}</td>
                <td className="muted">
                  {l.preset === 'custom' ? (
                    <>{l.zones.custom?.length ?? 0} custom zone{(l.zones.custom?.length ?? 0) === 1 ? '' : 's'}</>
                  ) : (
                    <>
                      Main: {playlistName(l.zones.main)}
                      {l.zones.side && <> · Side: {playlistName(l.zones.side)}</>}
                      {l.zones.ticker && <> · Ticker: {l.zones.ticker.texts.length} line{l.zones.ticker.texts.length === 1 ? '' : 's'}</>}
                    </>
                  )}
                </td>
                {canEdit && (
                  <td>
                    <button className="danger"
                      onClick={async () => {
                        if (confirm(`Delete layout "${l.name}"? Schedule slots using it are removed too.`)) {
                          await api(`/api/layouts/${l.id}`, { method: 'DELETE' });
                          await load();
                        }
                      }}>
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {layouts.length === 0 && <tr><td colSpan={4} className="muted">No layouts yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
