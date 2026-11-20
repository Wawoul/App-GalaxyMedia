import { useCallback, useEffect, useRef, useState } from 'react';
import { useUi, Menu, Modal, EmptyState, Skeleton, type MenuItem } from '../components/ui';
import { Icon } from '../components/icons';
import { formatSize, folderSubtree, LazyVideoThumb } from '../components/library';
import { api, uploadMedia } from '../api';
import type { Company, Folder, MediaItem } from '../types';

type View = 'grid' | 'list';
type TypeFilter = 'all' | 'image' | 'video' | 'slide';
const VIEW_KEY = 'gm:library-view';

/**
 * The Library: every image and video a company owns, in folders, ready to drop into playlists.
 * Thumbnail grid (or list), drag-and-drop upload, import by link, and the slide designer's output.
 */
export function Media({ company, canEdit }: { company: Company; canEdit: boolean }) {
  const ui = useUi();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  // media id -> design id, for the files that were made in the slide designer.
  const [designs, setDesigns] = useState<Record<string, string>>({});
  const [liveMedia, setLiveMedia] = useState<Set<string>>(new Set()); // pictures of slides that play live
  const [loaded, setLoaded] = useState(false);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [importing, setImporting] = useState<{ name: string; received: number; total: number | null } | null>(null);
  const [moving, setMoving] = useState<MediaItem | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [preview, setPreview] = useState<MediaItem | null>(null);
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'newest' | 'largest' | 'type'>('newest');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [view, setView] = useState<View>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
  });
  const setViewPersist = (v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-visit only */ }
  };
  const fileInput = useRef<HTMLInputElement>(null);
  // The import poll below outlives a render, so it needs to know if we are gone.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    const [m, f, d] = await Promise.all([
      api<MediaItem[]>(`/api/companies/${company.id}/media`),
      api<Folder[]>(`/api/companies/${company.id}/folders`),
      api<{ id: string; media_id: string | null; live?: boolean }[]>(`/api/companies/${company.id}/designs`).catch(() => []),
    ]);
    setItems(m);
    setFolders(f);
    setLiveMedia(new Set(d.flatMap((x) => (x.media_id && x.live ? [x.media_id] : []))));
    setDesigns(Object.fromEntries(d.flatMap((x) => (x.media_id ? [[x.media_id, x.id]] : []))));
    setLoaded(true);
  }, [company.id]);

  useEffect(() => {
    setCurrentFolder(null);
    setLoaded(false);
    void load().catch((err) => { setError(err instanceof Error ? err.message : 'failed'); setLoaded(true); });
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

  const upload = async (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (!list.length || !canEdit) return;
    setError('');
    try {
      for (const [i, file] of list.entries()) {
        const label = list.length > 1 ? `${file.name} (${i + 1} of ${list.length})` : file.name;
        setUploading({ name: label, percent: 0 });
        // Files over 25MB go up in pieces, so a proxy's per-request cap (Cloudflare: 100MB) never applies.
        await uploadMedia(company.id, file, (percent) => setUploading({ name: label, percent }), currentFolder);
      }
      await load();
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      setError(
        code === 'quota_exceeded' ? "Your company's storage is full - delete some files first."
          : code === 'server_disk_full' ? 'The server is low on disk space.'
          : code === 'too_large' ? 'That file is larger than the server allows.'
          : code === 'unsupported_type' ? 'That file type is not supported (images and videos only).'
          : code || 'upload failed',
      );
      await load().catch(() => undefined); // show whatever did arrive
    } finally {
      setUploading(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  /**
   * Import by URL: the server fetches the file itself, so the bytes never cross
   * the admin's connection. This is how a 300MB video gets in when a proxy caps
   * request bodies - Cloudflare's free plan stops uploads at 100MB - or when the
   * office uplink is simply slower than the server's.
   */
  const importFromUrl = async () => {
    const url = await ui.input(
      'Paste a direct link to the file.\n\n' +
        'The server downloads it itself, so this works for files too big to upload ' +
        '(e.g. through Cloudflare\'s 100MB limit).\n\n' +
        'Dropbox, Google Drive and OneDrive share links are converted automatically.',
    );
    if (!url?.trim()) return;
    setError('');
    try {
      // Returns as soon as the connection is open; the download continues
      // server-side and we poll it, since the browser can't watch bytes it
      // isn't carrying.
      const started = await api<{ jobId: string; name: string; totalBytes: number | null }>(
        `/api/companies/${company.id}/media/import`,
        { body: { url: url.trim(), folderId: currentFolder } },
      );
      setImporting({ name: started.name, received: 0, total: started.totalBytes });

      let done = false;
      while (!done) {
        await new Promise((r) => setTimeout(r, 1000));
        // Navigating away mid-import would otherwise leave this polling for the
        // life of the download and then setting state on a gone component.
        if (!mounted.current) return;
        const job = await api<{
          status: 'downloading' | 'done' | 'error';
          name: string;
          receivedBytes: number;
          totalBytes: number | null;
          error: string | null;
        }>(`/api/import-jobs/${started.jobId}`);
        if (job.status === 'downloading') {
          setImporting({ name: job.name, received: job.receivedBytes, total: job.totalBytes });
        } else {
          done = true;
          if (job.status === 'error') setError(job.error ?? 'import failed');
        }
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'import failed');
    } finally {
      setImporting(null);
    }
  };

  const createFolder = async () => {
    const name = await ui.input('Folder name:');
    if (name?.trim()) {
      void run(() =>
        api(`/api/companies/${company.id}/folders`, { body: { name: name.trim(), parentId: currentFolder } }),
      );
    }
  };

  const renameFile = async (m: MediaItem) => {
    const name = await ui.input('Rename file:', m.original_name);
    if (name?.trim()) void run(() => api(`/api/media/${m.id}`, { method: 'PATCH', body: { name: name.trim() } }));
  };
  const deleteFile = async (m: MediaItem) => {
    const slide = designs[m.id]
      ? ' It is a designed slide, so its editable design is deleted too and cannot be recovered.'
      : '';
    if (await ui.ask(`Delete "${m.original_name}"? It will be removed from playlists.${slide}`, { danger: true })) {
      void run(() => api(`/api/media/${m.id}`, { method: 'DELETE' }));
    }
  };
  const renameFolder = async (f: Folder) => {
    const name = await ui.input('Rename folder:', f.name);
    if (name?.trim()) void run(() => api(`/api/folders/${f.id}`, { method: 'PATCH', body: { name: name.trim() } }));
  };
  const deleteFolder = async (f: Folder) => {
    if (await ui.ask(`Delete folder "${f.name}"? Its contents move up a level (nothing is lost).`)) {
      void run(() => api(`/api/folders/${f.id}`, { method: 'DELETE' }));
    }
  };
  const deleteFolderAndContents = async (f: Folder) => {
    const subtree = folderSubtree(f.id, folders);
    const inside = items.filter((m) => m.folder_id && subtree.has(m.folder_id));
    const slides = inside.filter((m) => designs[m.id]).length;
    const folderCount = subtree.size - 1; // exclude f itself
    const warning = inside.length > 0
      ? `Permanently delete folder "${f.name}" and everything inside it - ` +
        `${inside.length} file${inside.length === 1 ? '' : 's'}` +
        (folderCount > 0 ? ` across ${folderCount} subfolder${folderCount === 1 ? '' : 's'}` : '') +
        `? Deleted files are also removed from any playlists using them.` +
        (slides > 0 ? ` ${slides} designed slide${slides === 1 ? ' is' : 's are'} included, and their editable designs go too.` : '') +
        ` This cannot be undone.`
      : `Delete empty folder "${f.name}" and its ${folderCount} empty subfolder${folderCount === 1 ? '' : 's'}?`;
    if (await ui.ask(warning, { danger: true })) {
      void run(() => api(`/api/folders/${f.id}?recursive=true`, { method: 'DELETE' }));
    }
  };

  const openFolder = (id: string | null) => { setSearch(''); setCurrentFolder(id); };

  const fileMenu = (m: MediaItem): MenuItem[] => {
    const items: MenuItem[] = [];
    if (designs[m.id] && canEdit) items.push({ label: 'Edit design…', onSelect: () => { window.location.hash = `#/designer/${designs[m.id]}`; } });
    if (canEdit) {
      items.push(
        { label: 'Rename', onSelect: () => void renameFile(m) },
        { label: 'Move to folder…', onSelect: () => { setMoveTarget(m.folder_id ?? ''); setMoving(m); } },
        { label: 'Duplicate', onSelect: () => void run(() => api(`/api/media/${m.id}/duplicate`, { body: {} })) },
      );
    }
    items.push({ label: 'Download', onSelect: () => window.open(`${m.url}&download=1`, '_blank') });
    if (canEdit) items.push({ label: 'Delete', danger: true, separator: true, onSelect: () => void deleteFile(m) });
    return items;
  };
  const folderMenu = (f: Folder): MenuItem[] => [
    { label: 'Open', onSelect: () => openFolder(f.id) },
    ...(canEdit ? [
      { label: 'Rename', onSelect: () => void renameFolder(f) },
      { label: 'Delete (keep contents)', danger: true, separator: true, onSelect: () => void deleteFolder(f) },
      { label: 'Delete folder and contents', danger: true, onSelect: () => void deleteFolderAndContents(f) },
    ] : []),
  ];

  // Breadcrumb trail from root to the current folder.
  const trail: Folder[] = [];
  for (let f = folders.find((x) => x.id === currentFolder); f; f = folders.find((x) => x.id === f!.parent_id)) {
    trail.unshift(f);
  }
  // Search matches across the whole library; otherwise show the current folder.
  const query = search.trim().toLowerCase();
  const subfolders = typeFilter !== 'all' && !query ? [] : (query
    ? folders.filter((f) => f.name.toLowerCase().includes(query))
    : folders.filter((f) => f.parent_id === currentFolder)
  ).sort((a, b) => a.name.localeCompare(b.name));
  const matchesType = (m: MediaItem) =>
    typeFilter === 'all' || (typeFilter === 'slide' ? !!designs[m.id] : typeFilter === m.kind);
  const files = (query || typeFilter !== 'all'
    ? items.filter((m) => (!query || m.original_name.toLowerCase().includes(query)))
    : items.filter((m) => m.folder_id === currentFolder)
  ).filter(matchesType).sort((a, b) => {
    switch (sortBy) {
      case 'newest': return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      case 'largest': return b.size_bytes - a.size_bytes;
      case 'type': return a.mime.localeCompare(b.mime) || a.original_name.localeCompare(b.original_name);
      default: return a.original_name.localeCompare(b.original_name);
    }
  });
  const folderChoices = [{ id: '', name: '(Library root)' }, ...folders.map((f) => ({ id: f.id, name: f.name }))];
  const busy = uploading !== null || importing !== null;
  const empty = subfolders.length === 0 && files.length === 0;
  const folderCount = (id: string) => items.filter((m) => m.folder_id === id).length + folders.filter((f) => f.parent_id === id).length;

  // Drag-and-drop: only react to real files, and ignore the dragleave that fires on child elements.
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const dropProps = canEdit ? {
    onDragEnter: (e: React.DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setDragging(true); } },
    onDragOver: (e: React.DragEvent) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (e: React.DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files); } },
  } : {};

  const thumb = (m: MediaItem) =>
    m.kind === 'image' ? <img src={m.url} alt="" loading="lazy" /> : <LazyVideoThumb src={m.url} className="lib-vid" />;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Library</h2>
          <div className="page-sub">
            Upload files for your playlists{canEdit ? ' - or drag and drop them anywhere on this page' : ''}. Add them to playlists from the <strong>Playlists</strong> tab.
          </div>
        </div>
      </div>

      {canEdit && (
        <div className="lib-actions">
          <input ref={fileInput} type="file" multiple style={{ display: 'none' }}
            accept="image/jpeg,image/png,image/gif,image/bmp,image/webp,video/mp4,video/quicktime,video/webm,video/x-matroska,.mkv,.mov"
            onChange={(e) => void upload(e.target.files)} />
          <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={busy}>
            <Icon name="upload" size={16} /> Upload
          </button>
          <button type="button" className="btn" onClick={() => void importFromUrl()} disabled={busy}
            title="The server downloads the file itself - use this for files too large to upload">
            <Icon name="search" size={16} /> From URL
          </button>
          <button type="button" className="btn" onClick={() => void createFolder()}><Icon name="plus" size={16} /> New folder</button>
          <a className="btn" href="#/designer/new" title="Design a slide with text, shapes and images"><Icon name="text" size={16} /> New slide</a>
        </div>
      )}

      {uploading && (
        <div className="lib-progress" role="status">
          <span>Uploading <b>{uploading.name}</b></span>
          <progress value={uploading.percent} max={100} />
          <span className="muted">{uploading.percent}%</span>
        </div>
      )}
      {importing && (
        <div className="lib-progress" role="status">
          <span>Downloading <b>{importing.name}</b></span>
          {/* A source that sent no Content-Length gives no total, so show an indeterminate bar and
              the bytes so far rather than a percentage that would be a guess. */}
          {importing.total ? (
            <>
              <progress value={importing.received} max={importing.total} />
              <span className="muted">{Math.round((importing.received / importing.total) * 100)}% of {formatSize(importing.total)}</span>
            </>
          ) : (
            <>
              <progress />
              <span className="muted">{formatSize(importing.received)}</span>
            </>
          )}
        </div>
      )}

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={16} />
          <input type="search" aria-label="Search the library" placeholder="Search all files…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select aria-label="Show" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}>
          <option value="all">All files</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
          <option value="slide">Designed slides</option>
        </select>
        <select aria-label="Sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
          <option value="newest">Sort: Newest</option>
          <option value="name">Sort: Name</option>
          <option value="largest">Sort: Largest</option>
          <option value="type">Sort: Type</option>
        </select>
        <div className="grow" />
        <div className="seg" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'grid'} onClick={() => setViewPersist('grid')}><Icon name="grid" size={16} /> Grid</button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setViewPersist('list')}><Icon name="list" size={16} /> List</button>
        </div>
      </div>

      <div className="lib-crumbs" style={{ marginBottom: 12 }}>
        <button type="button" className="crumb" onClick={() => openFolder(null)}>Library</button>
        {trail.map((f) => (
          <span key={f.id}>
            <span className="muted"> / </span>
            <button type="button" className="crumb" onClick={() => openFolder(f.id)}>{f.name}</button>
          </span>
        ))}
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      <div className={`lib-drop${dragging ? ' over' : ''}`} {...dropProps}>
        {!loaded ? (
          <div className="panel"><Skeleton lines={5} /></div>
        ) : empty ? (
          <div className="panel">
            <EmptyState icon="image" title={query || typeFilter !== 'all' ? 'Nothing matches' : currentFolder ? 'This folder is empty' : 'Your library is empty'}
              action={canEdit && !query && typeFilter === 'all' ? <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}><Icon name="upload" size={16} /> Upload files</button> : undefined}>
              {query || typeFilter !== 'all' ? 'Try a different search or filter.' : canEdit ? 'Upload images and videos, or drop files here.' : 'Nothing has been uploaded yet.'}
            </EmptyState>
          </div>
        ) : view === 'grid' ? (
          <div className="lib-grid">
            {subfolders.map((f) => (
              <div key={f.id} className="lib-card lib-folder-card">
                <button type="button" className="lib-folder-art" onClick={() => openFolder(f.id)} aria-label={`Open folder ${f.name}`}>
                  <Icon name="folder" size={40} />
                </button>
                <div className="lib-meta">
                  <span className="lib-name" title={f.name}>{f.name}</span>
                  <div className="lib-sub">{folderCount(f.id)} item{folderCount(f.id) === 1 ? '' : 's'}</div>
                </div>
                <div className="lib-menu"><Menu items={folderMenu(f)} label={`Actions for folder ${f.name}`} /></div>
              </div>
            ))}
            {files.map((m) => (
              <div key={m.id} className="lib-card">
                <button type="button" className="lib-thumb" onClick={() => setPreview(m)} aria-label={`Preview ${m.original_name}`}>
                  {thumb(m)}
                  {m.kind === 'video' && <span className="lib-badge">Video</span>}
                  {designs[m.id] && <span className="lib-badge ok">{liveMedia.has(m.id) ? 'Live slide' : 'Slide'}</span>}
                </button>
                <div className="lib-meta">
                  <span className="lib-name" title={m.original_name}>{m.original_name}</span>
                  <div className="lib-sub">{new Date(m.created_at).toLocaleDateString()} · {formatSize(m.size_bytes)}</div>
                </div>
                <div className="lib-menu"><Menu items={fileMenu(m)} label={`Actions for ${m.original_name}`} /></div>
              </div>
            ))}
          </div>
        ) : (
          <div className="panel" style={{ padding: 0 }}>
            <div className="table-wrap"><table>
              <thead><tr><th></th><th>Name</th><th>Type</th><th>Size</th><th>Added</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {subfolders.map((f) => (
                  <tr key={f.id}>
                    <td><span className="lib-list-thumb" style={{ display: 'grid', placeItems: 'center', color: 'var(--accent)' }}><Icon name="folder" size={20} /></span></td>
                    <td><button type="button" className="crumb" onClick={() => openFolder(f.id)}>{f.name}</button></td>
                    <td className="muted">folder</td>
                    <td className="muted">{folderCount(f.id)} item{folderCount(f.id) === 1 ? '' : 's'}</td>
                    <td></td>
                    <td style={{ textAlign: 'right' }}><Menu items={folderMenu(f)} label={`Actions for folder ${f.name}`} /></td>
                  </tr>
                ))}
                {files.map((m) => (
                  <tr key={m.id}>
                    <td><button type="button" className="lib-list-thumb" style={{ padding: 0, border: 0 }} onClick={() => setPreview(m)} aria-label={`Preview ${m.original_name}`}>{thumb(m)}</button></td>
                    <td>{m.original_name} {designs[m.id] && <span className="badge ok">{liveMedia.has(m.id) ? 'Live slide' : 'Slide'}</span>}</td>
                    <td className="muted">{m.mime}</td>
                    <td className="muted">{formatSize(m.size_bytes)}</td>
                    <td className="muted">{new Date(m.created_at).toLocaleDateString()}</td>
                    <td style={{ textAlign: 'right' }}><Menu items={fileMenu(m)} label={`Actions for ${m.original_name}`} /></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </div>

      {preview && (
        <Modal wide title={preview.original_name} onClose={() => setPreview(null)}
          actions={(
            <>
              {designs[preview.id] && canEdit && (
                <a className="btn" href={`#/designer/${designs[preview.id]}`}>Edit design</a>
              )}
              <button type="button" className="btn" onClick={() => window.open(`${preview.url}&download=1`, '_blank')}>Download</button>
              <button type="button" className="btn btn-primary" onClick={() => setPreview(null)}>Close</button>
            </>
          )}>
          <div className="lib-preview">
            {preview.kind === 'image'
              ? <img src={preview.url} alt={preview.original_name} />
              : <video src={preview.url} controls autoPlay muted />}
          </div>
          <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
            {preview.mime} · {formatSize(preview.size_bytes)} · added {new Date(preview.created_at).toLocaleDateString()}
          </div>
        </Modal>
      )}

      {moving && (
        <Modal title={`Move "${moving.original_name}"`} onClose={() => setMoving(null)}
          actions={(
            <>
              <button type="button" className="btn" onClick={() => setMoving(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={() => {
                const m = moving;
                setMoving(null);
                void run(() => api(`/api/media/${m.id}`, { method: 'PATCH', body: { folderId: moveTarget || null } }));
              }}>Move here</button>
            </>
          )}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span className="muted">Destination folder</span>
            <select value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)}>
              {folderChoices.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
        </Modal>
      )}
    </>
  );
}
