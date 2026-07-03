import { useRef, useState } from 'react';
import { api } from '../api';
import type { Company } from '../types';

/** Trigger a browser download of a JSON API response (auth header required, so no plain link). */
async function downloadExport(company: Company) {
  const doc = await api<unknown>(`/api/companies/${company.id}/export`);
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `galaxy-${company.name.replace(/[^\w-]+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function Companies({
  companies,
  reload,
  canCreate,
}: {
  companies: Company[];
  reload: () => Promise<void>;
  canCreate: boolean;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const importInput = useRef<HTMLInputElement>(null);
  const [importTarget, setImportTarget] = useState<Company | null>(null);

  const runImport = async (file: File) => {
    setError('');
    setStatus('');
    try {
      const doc = JSON.parse(await file.text()) as { exportedFrom?: string };

      // No target selected: create a fresh company for this config first.
      let target = importTarget;
      if (!target) {
        const suggested = doc.exportedFrom ? `${doc.exportedFrom}` : 'Imported company';
        const name = window.prompt('Name for the new company:', suggested);
        if (!name?.trim()) return;
        target = await api<Company>('/api/companies', { body: { name: name.trim() } });
      }

      const summary = await api<{
        groups: number; playlists: number; layouts: number; assignments: number;
        skippedItems: number; skippedLayouts: number;
      }>(
        `/api/companies/${target.id}/import`,
        { body: doc },
      );
      setStatus(
        `Imported into ${target.name}: ${summary.groups} groups, ${summary.playlists} playlists, ` +
        `${summary.layouts} layouts, ${summary.assignments} schedule entries.` +
        (summary.skippedItems > 0
          ? ` ${summary.skippedItems} playlist item(s) skipped - upload the matching media files first, then re-import.`
          : '') +
        (summary.skippedLayouts > 0
          ? ` ${summary.skippedLayouts} layout(s) skipped - a required zone's playlist didn't import.`
          : ''),
      );
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'import failed');
    } finally {
      setImportTarget(null);
      if (importInput.current) importInput.current.value = '';
    }
  };

  return (
    <>
      <h2>Companies</h2>
      {canCreate && (
        <div className="panel row spread">
          <div className="row">
            <input placeholder="New company name" value={name} onChange={(e) => setName(e.target.value)} />
            <button disabled={!name}
              onClick={async () => {
                setError('');
                try {
                  await api('/api/companies', { body: { name } });
                  setName('');
                  await reload();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'failed');
                }
              }}>
              Add company
            </button>
          </div>
          <button className="secondary"
            onClick={() => {
              setImportTarget(null); // null target = create a new company from the file
              importInput.current?.click();
            }}>
            Import as new company…
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {status && <div className="panel muted">{status}</div>}
      <input ref={importInput} type="file" accept=".json" style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void runImport(file);
        }} />
      <div className="panel">
        <table>
          <thead>
            <tr><th>Name</th><th>Screens</th><th>Extra alert recipients</th><th>Brand name (white-label)</th>{canCreate && <th></th>}</tr>
          </thead>
          <tbody>
            {companies.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="muted">{c.screen_count}</td>
                <td>
                  <input
                    // key on the server value so a concurrent change (or import)
                    // remounts the input instead of keeping stale typed text
                    key={`emails-${c.id}-${c.alert_emails}`}
                    defaultValue={c.alert_emails}
                    placeholder="client@example.com (optional)"
                    style={{ minWidth: 220 }}
                    onBlur={async (e) => {
                      if (e.target.value.trim() !== c.alert_emails) {
                        await api(`/api/companies/${c.id}`, {
                          method: 'PATCH',
                          body: { alertEmails: e.target.value.trim() },
                        });
                        await reload();
                      }
                    }} />
                </td>
                <td>
                  <input
                    key={`brand-${c.id}-${c.brand_name}`}
                    defaultValue={c.brand_name}
                    placeholder="Shown on TVs (optional)"
                    style={{ minWidth: 160 }}
                    onBlur={async (e) => {
                      if (e.target.value.trim() !== c.brand_name) {
                        await api(`/api/companies/${c.id}`, {
                          method: 'PATCH',
                          body: { brandName: e.target.value.trim() },
                        });
                        await reload();
                      }
                    }} />
                </td>
                {canCreate && (
                  <td>
                    <div className="row">
                      <button className="secondary" onClick={() => void downloadExport(c)}>Export</button>
                      <button className="secondary"
                        onClick={() => {
                          setImportTarget(c);
                          importInput.current?.click();
                        }}>
                        Import
                      </button>
                      <button className="danger"
                        onClick={async () => {
                          if (confirm(`Delete "${c.name}" and ALL its screens, media and playlists? This cannot be undone.`)) {
                            await api(`/api/companies/${c.id}`, { method: 'DELETE' });
                            await reload();
                          }
                        }}>
                        Delete
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {companies.length === 0 && <tr><td colSpan={5} className="muted">No companies yet.</td></tr>}
          </tbody>
        </table>
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          Offline alerts always go to the global recipients in the Alerts tab; addresses here
          are notified additionally, but only for that company's screens.
          <br />
          Export/Import moves a company's setup (groups, playlists, layouts, schedule) as JSON -
          handy as a template for new clients. Media files are matched by content hash, so upload
          the same files to the target company first.
        </div>
      </div>
    </>
  );
}
