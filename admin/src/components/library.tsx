import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Folder, MediaItem } from '../types';
import { Icon } from './icons';
import { EmptyState, Modal, Skeleton } from './ui';
import './library.css';

/**
 * A video thumbnail that only starts loading once it scrolls near the viewport. With
 * preload="metadata" on every tile, opening a large library fired one request per video
 * straight away (and kept the ones further down the page loading while you looked at the top).
 */
export function LazyVideoThumb({ src, className = 'thumb' }: { src: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return <video ref={ref} className={className} src={near ? src : undefined} muted preload={near ? 'metadata' : 'none'} />;
}

export function formatSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/** Folder id + every descendant folder id beneath it (incl. itself). */
export function folderSubtree(rootId: string, folders: Folder[]): Set<string> {
  const ids = new Set([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const f of folders) {
      if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) {
        ids.add(f.id);
        added = true;
      }
    }
  }
  return ids;
}

/**
 * Pick files from the library - the same grid and folders as the Library page - to add to a
 * playlist. Multi-select: click tiles, then "Add". Folders are navigable; search covers everything.
 */
export function LibraryPicker({ companyId, onAdd, onClose }: {
  companyId: string;
  onAdd: (items: MediaItem[]) => void;
  onClose: () => void;
}) {
  const [media, setMedia] = useState<MediaItem[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [error, setError] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    Promise.all([
      api<MediaItem[]>(`/api/companies/${companyId}/media`),
      api<Folder[]>(`/api/companies/${companyId}/folders`),
    ])
      .then(([m, f]) => { if (live) { setMedia(m); setFolders(f); } })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : 'Could not load the library'); });
    return () => { live = false; };
  }, [companyId]);

  const q = search.trim().toLowerCase();
  const shownFolders = useMemo(
    () => (q ? folders.filter((f) => f.name.toLowerCase().includes(q)) : folders.filter((f) => f.parent_id === folder))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [folders, folder, q],
  );
  const files = useMemo(
    () => (media ?? [])
      .filter((m) => (q ? m.original_name.toLowerCase().includes(q) : m.folder_id === folder))
      .sort((a, b) => a.original_name.localeCompare(b.original_name)),
    [media, folder, q],
  );
  const trail: Folder[] = [];
  for (let f = folders.find((x) => x.id === folder); f; f = folders.find((x) => x.id === f!.parent_id)) trail.unshift(f);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const confirm = () => onAdd((media ?? []).filter((m) => picked.includes(m.id)).sort((a, b) => picked.indexOf(a.id) - picked.indexOf(b.id)));

  return (
    <Modal
      wide
      title="Add from library"
      onClose={onClose}
      actions={(
        <>
          <span className="muted lib-picker-count">{picked.length === 0 ? 'Click files to select them' : `${picked.length} selected`}</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={picked.length === 0} onClick={confirm}>
            Add {picked.length > 0 ? picked.length : ''} to playlist
          </button>
        </>
      )}
    >
      <div className="lib-picker">
        <div className="lib-picker-bar">
          <div className="search">
            <Icon name="search" size={16} />
            <input type="search" aria-label="Search the library" placeholder="Search the library…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="lib-crumbs">
            <button type="button" className="crumb" onClick={() => { setSearch(''); setFolder(null); }}>Library</button>
            {trail.map((f) => (
              <span key={f.id}><span className="muted"> / </span>
                <button type="button" className="crumb" onClick={() => { setSearch(''); setFolder(f.id); }}>{f.name}</button>
              </span>
            ))}
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        {!media && !error ? <Skeleton lines={5} /> : shownFolders.length === 0 && files.length === 0 ? (
          <EmptyState icon="image" title={q ? 'Nothing matches' : 'This folder is empty'}>
            {q ? 'Try a different search.' : 'Upload files on the Library page, then add them here.'}
          </EmptyState>
        ) : (
          <div className="lib-grid lib-grid-sm">
            {shownFolders.map((f) => (
              <button key={f.id} type="button" className="lib-card lib-folder" onClick={() => { setSearch(''); setFolder(f.id); }}>
                <span className="lib-folder-art"><Icon name="folder" size={34} /></span>
                <span className="lib-name">{f.name}</span>
              </button>
            ))}
            {files.map((m) => {
              const on = picked.includes(m.id);
              return (
                <button key={m.id} type="button" className={`lib-card lib-pick${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(m.id)} title={m.original_name}>
                  <span className="lib-thumb">
                    {m.kind === 'image' ? <img src={m.url} alt="" loading="lazy" /> : <LazyVideoThumb src={m.url} className="lib-vid" />}
                    {m.kind === 'video' && <span className="lib-badge">Video</span>}
                    {on && <span className="lib-check" aria-hidden="true"><Icon name="check" size={16} /></span>}
                  </span>
                  <span className="lib-name">{m.original_name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
