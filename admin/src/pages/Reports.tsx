import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Company } from '../types';

interface PlayRow {
  day: string;
  screen_name: string;
  item_name: string;
  plays: number;
  last_played: string;
}

export function Reports({ company }: { company: Company }) {
  const [rows, setRows] = useState<PlayRow[]>([]);
  const [days, setDays] = useState(7);
  const [screenFilter, setScreenFilter] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setRows(await api<PlayRow[]>(`/api/companies/${company.id}/reports/proof-of-play?days=${days}`));
  }, [company.id, days]);

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : 'failed'));
  }, [load]);

  const screens = [...new Set(rows.map((r) => r.screen_name))].sort();
  const visible = screenFilter ? rows.filter((r) => r.screen_name === screenFilter) : rows;
  const totalPlays = visible.reduce((sum, r) => sum + r.plays, 0);

  const downloadCsv = () => {
    const lines = [
      'day,screen,item,plays,last_played',
      ...visible.map((r) =>
        [r.day, r.screen_name, r.item_name, r.plays, r.last_played]
          .map((value) => `"${String(value).replaceAll('"', '""')}"`)
          .join(','),
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `proof-of-play-${company.name.replace(/[^\w-]+/g, '_')}-${days}d.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <h2>Reports</h2>
      <div className="panel row spread">
        <div className="row">
          <span className="muted">Proof of play, last</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>24 hours</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <select value={screenFilter} onChange={(e) => setScreenFilter(e.target.value)}>
            <option value="">All screens</option>
            {screens.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <span className="muted">{totalPlays.toLocaleString()} plays</span>
        </div>
        <button className="secondary" onClick={downloadCsv} disabled={visible.length === 0}>
          Download CSV
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="panel">
        <table>
          <thead><tr><th>Day</th><th>Screen</th><th>Item</th><th>Plays</th><th>Last played</th></tr></thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={i}>
                <td className="muted">{r.day}</td>
                <td>{r.screen_name}</td>
                <td>{r.item_name}</td>
                <td>{r.plays.toLocaleString()}</td>
                <td className="muted">{new Date(r.last_played).toLocaleString()}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={5} className="muted">
                No plays recorded yet. TVs report plays with each heartbeat (needs the current app build).
              </td></tr>
            )}
          </tbody>
        </table>
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          Days are UTC. Play logs are kept for 90 days.
        </div>
      </div>
    </>
  );
}
