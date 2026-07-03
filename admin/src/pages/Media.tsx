import { useCallback, useEffect, useRef, useState } from 'react';
import { api, uploadWithProgress } from '../api';
import type { Company, Folder, MediaItem } from '../types';

function formatSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

export function Media({ company, canEdit }: { company: Company; canEdit: boolean }) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [m, f] = await Promise.all([
      api<MediaItem[]>(`/api/companies/${company.id}/media`),
      api<Folder[]>(`/api/companies/${company.id}/folders`),
    ]);
    setItems(m);
    setFolders(f);
  }, [company.id]);

  useEffect(() => {
    setCurrentFolder(null);
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

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    try {
      for (const file of Array.from(files)) {
        setUploading({ name: file.name, percent: 0 });
        await uploadWithProgress(
          `/api/companies/${company.id}/media`,
          file,
          (percent) => setUploading({ name: file.name, percent }),
          currentFolder ? { folderId: currentFolder } : {},
        );
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed');
    } finally {
      setUploading(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const createFolder = () => {
    const name = window.prompt('Folder name:');
    if (name?.trim()) {
      void run(() =>
        api(`/api/companies/${company.id}/folders`, { body: { name: name.trim(), parentId: currentFolder } }),
      );
    }
  };

  // Breadcrumb trail from root to the current folder.
  const trail: Folder[] = [];
  for (let f = folders.find((x) => x.id === currentFolder); f; f = folders.find((x) => x.id === f!.parent_id)) {
    trail.unshift(f);
  }
  const subfolders = folders.filter((f) => f.parent_id === currentFolder);
  const files = items.filter((m) => m.folder_id === currentFolder);
  const folderChoices = [{ id: '', name: '(Library root)' }, ...folders.map((f) => ({ id: f.id, name: f.name }))];

  return (
    <>
      <h2>Media</h2>

      <div className="panel row spread">
        <div className="row">
          <span className="crumb" onClick={() => setCurrentFolder(null)}>Library</span>
          {trail.map((f) => (
            <span key={f.id}>
              <span className="muted"> / </span>
              <span className="crumb" onClick={() => setCurrentFolder(f.id)}>{f.name}</span>
            </span>
          ))}
        </div>
        {canEdit && (
          <div className="row">
            <button className="secondary" onClick={createFolder}>+ New folder</button>
            <input ref={fileInput} type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4"
              onChange={(e) => upload(e.target.files)} disabled={uploading !== null} />
            {uploading && (
              <div className="row" style={{ minWidth: 240 }}>
                <span className="muted">{uploading.name}</span>
                <progress value={uploading.percent} max={100} style={{ width: 100 }} />
                <span className="muted">{uploading.percent}%</span>
              </div>
            )}
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr><th></th><th>Name</th><th>Type</th><th>Size</th><th>Added</th>{canEdit && <th></th>}</tr>
          </thead>
          <tbody>
            {subfolders.map((f) => {
              const count = items.filter((m) => m.folder_id === f.id).length;
              return (
                <tr key={f.id}>
                  <td style={{ fontSize: 22 }}>📁</td>
                  <td><span className="crumb" onClick={() => setCurrentFolder(f.id)}>{f.name}</span></td>
                  <td className="muted">folder</td>
                  <td className="muted">{count} item{count === 1 ? '' : 's'}</td>
                  <td></td>
                  {canEdit && (
                    <td>
                      <select value="" onChange={(e) => {
                        const action = e.target.value;
                        if (action === 'rename') {
                          const name = window.prompt('Rename folder:', f.name);
                          if (name?.trim()) void run(() => api(`/api/folders/${f.id}`, { method: 'PATCH', body: { name: name.trim() } }));
                        } else if (action === 'delete') {
                          if (confirm(`Delete folder "${f.name}"? Its contents move up a level (nothing is lost).`)) {
                            void run(() => api(`/api/folders/${f.id}`, { method: 'DELETE' }));
                          }
                        }
                      }}>
                        <option value="" disabled>Actions…</option>
                        <option value="rename">Rename</option>
                        <option value="delete">Delete (keep contents)</option>
                      </select>
                    </td>
                  )}
                </tr>
              );
            })}
            {files.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.kind === 'image'
                    ? <img className="thumb" src={m.url} alt="" loading="lazy" />
                    : <video className="thumb" src={m.url} muted preload="metadata" />}
                </td>
                <td>{m.original_name}</td>
                <td className="muted">{m.mime}</td>
                <td className="muted">{formatSize(m.size_bytes)}</td>
                <td className="muted">{new Date(m.created_at).toLocaleDateString()}</td>
                {canEdit && (
                  <td>
                    {movingId === m.id ? (
                      <div className="row">
                        <select defaultValue={m.folder_id ?? ''} onChange={(e) => {
                          void run(() => api(`/api/media/${m.id}`, { method: 'PATCH', body: { folderId: e.target.value || null } }));
                          setMovingId(null);
                        }}>
                          {folderChoices.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                        <button className="secondary" onClick={() => setMovingId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <select value="" onChange={(e) => {
                        const action = e.target.value;
                        if (action === 'rename') {
                          const name = window.prompt('Rename file:', m.original_name);
                          if (name?.trim()) {
                            void run(() => api(`/api/media/${m.id}`, { method: 'PATCH', body: { name: name.trim() } }));
                          }
                        }
                        else if (action === 'move') setMovingId(m.id);
                        else if (action === 'duplicate') void run(() => api(`/api/media/${m.id}/duplicate`, { body: {} }));
                        else if (action === 'download') window.open(`${m.url}&download=1`, '_blank');
                        else if (action === 'delete') {
                          if (confirm(`Delete "${m.original_name}"? It will be removed from playlists.`)) {
                            void run(() => api(`/api/media/${m.id}`, { method: 'DELETE' }));
                          }
                        }
                      }}>
                        <option value="" disabled>Actions…</option>
                        <option value="rename">Rename</option>
                        <option value="move">Move to folder…</option>
                        <option value="duplicate">Duplicate</option>
                        <option value="download">Download</option>
                        <option value="delete">Delete</option>
                      </select>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {subfolders.length === 0 && files.length === 0 && (
              <tr><td colSpan={6} className="muted">
                {currentFolder ? 'Empty folder.' : 'No media yet - upload images or videos above.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
