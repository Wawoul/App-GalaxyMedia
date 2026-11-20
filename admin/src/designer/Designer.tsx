import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { Icon, type IconName } from '../components/icons';
import { Menu, Modal, useMediaQuery, useUi } from '../components/ui';
import type { Company, MediaItem } from '../types';
import { Canvas, type CanvasHandle, type Patch } from './Canvas';
import { ensureFonts } from './fonts';
import { LivePreview } from './LivePreview';
import {
  clamp, cloneObj, emptyDoc, isLiveDoc, isPortrait, LANDSCAPE, makeImage, makeShape, makeText, makeWidget, PORTRAIT,
  type DesignDoc, type Obj, type SlideSize, type WidgetObj,
} from './model';
import {
  ElementsPanel, ImagesPanel, LayersPanel, Properties, TemplatesPanel, ColorField, Section,
  type AlignKind, type Order,
} from './Panels';
import { useHistory } from './useHistory';
import './designer.css';

type Tab = 'elements' | 'images' | 'background' | 'templates' | 'layers';
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'elements', label: 'Elements', icon: 'shapes' },
  { id: 'images', label: 'Images', icon: 'image' },
  { id: 'background', label: 'Background', icon: 'palette' },
  { id: 'templates', label: 'Templates', icon: 'template' },
  { id: 'layers', label: 'Layers', icon: 'layers' },
];

interface TemplateRow { id: string; name: string; width: number; height: number; preview?: string }
interface SavedDesign {
  id: string; company_id: string; name: string; width: number; height: number;
  media_id: string | null; version: number; document: DesignDoc;
}

/** Signed image links last 45 minutes; a long editing session refreshes the list well before that. */
const MEDIA_REFRESH_MS = 25 * 60_000;
const DRAFT_DELAY_MS = 1200;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `#/designer/<id|new>?playlist=<id>` -> parts. */
function parseHash(hash: string): { id: string; playlist: string | null } {
  const [path, qs = ''] = hash.replace(/^#\/?/, '').split('?');
  const id = (path ?? '').split('/')[1] || 'new';
  return { id, playlist: new URLSearchParams(qs).get('playlist') };
}

const stripPreview = (d: DesignDoc): DesignDoc => { const { preview: _p, ...rest } = d; return rest as DesignDoc; };

const ERRORS: Record<string, string> = {
  quota_exceeded: "Your company's storage is full - delete some media first.",
  server_disk_full: 'The server is low on disk space.',
  too_large: 'The rendered slide is too large to store.',
  unsupported_type: 'The slide could not be rendered as a PNG.',
  media_not_found: 'An image on this slide was removed from the library.',
  media_not_in_company: 'An image on this slide belongs to a different company.',
  playlist_not_found: 'That playlist no longer exists.',
  folder_not_found: 'That folder no longer exists.',
  is_template: 'Templates are not published - save a slide instead.',
  invalid_design: 'This slide could not be saved (its data was rejected).',
  forbidden: "You don't have permission to change this slide.",
  not_found: 'This slide no longer exists.',
  conflict: 'Someone else saved this slide first.',
};
function errorText(err: unknown): string {
  if (err instanceof ApiError) return ERRORS[err.message] ?? err.message;
  return err instanceof Error ? err.message : 'Something went wrong';
}

const measure = (url: string) => new Promise<{ w: number; h: number } | null>((resolve) => {
  const im = new window.Image();
  im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
  im.onerror = () => resolve(null);
  im.src = url;
});

// ── drafts: unsaved work survives a reload, a crash or the browser Back button ────────────
interface Draft { name: string; doc: DesignDoc; at: number }
const draftKey = (id: string) => `gm:draft:${id}`;
function readDraft(id: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(id));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch { return null; }
}
function writeDraft(id: string, draft: Draft): void {
  try { localStorage.setItem(draftKey(id), JSON.stringify(draft)); } catch { /* storage full or blocked: drafts are best-effort */ }
}
function clearDraft(id: string): void {
  try { localStorage.removeItem(draftKey(id)); } catch { /* ignore */ }
}

export default function Designer({ company, canEdit, hash }: { company: Company; canEdit: boolean; hash: string }) {
  const ui = useUi();
  const wide = useMediaQuery('(min-width: 900px)');
  const params = useMemo(() => parseHash(hash), [hash]);
  const canvas = useRef<CanvasHandle>(null);
  const work = useRef<HTMLDivElement>(null);
  const clip = useRef<Obj[]>([]);
  const savingRef = useRef(false);
  const urlCache = useRef(new Map<string, string>());

  const history = useHistory<DesignDoc>(emptyDoc());
  const doc = history.doc;
  const slide: SlideSize = doc.size ?? LANDSCAPE;
  const [designId, setDesignId] = useState<string | null>(params.id === 'new' ? null : params.id);
  const [version, setVersion] = useState(1);
  const [name, setName] = useState('Untitled slide');
  const [chosen, setChosen] = useState(params.id !== 'new'); // orientation picked (or slide loaded)
  const [baseline, setBaseline] = useState<string | null>(null);
  const [loading, setLoading] = useState(params.id !== 'new');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  // The library to draw images from is the SLIDE's company, which is not necessarily the one
  // selected in the sidebar (a bookmarked link, or an MSP admin working across companies).
  const [mediaCompany, setMediaCompany] = useState(company.id);

  const [tab, setTab] = useState<Tab>('elements');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [zoomMode, setZoomMode] = useState<'fit' | number>('fit');
  const [area, setArea] = useState({ w: 900, h: 600 });
  const [fontsVersion, setFontsVersion] = useState(0);

  const returnHash = params.playlist ? `#/playlists?open=${params.playlist}` : '#/media';
  const key = designId ?? 'new';

  // ── data ───────────────────────────────────────────────────────────────────────────────
  const loadMedia = useCallback(async () => {
    const list = await api<MediaItem[]>(`/api/companies/${mediaCompany}/media`);
    setMedia(list);
    setMediaLoading(false);
    return list;
  }, [mediaCompany]);

  const loadTemplates = useCallback(async () => {
    try {
      setTemplates(await api<TemplateRow[]>(`/api/companies/${mediaCompany}/designs?templates=true`));
    } finally {
      setTemplatesLoading(false);
    }
  }, [mediaCompany]);

  useEffect(() => { void loadMedia().catch(() => setMediaLoading(false)); }, [loadMedia]);
  useEffect(() => { void loadTemplates().catch(() => setTemplatesLoading(false)); }, [loadTemplates]);
  // A long session must not outlive the signed image links.
  useEffect(() => {
    const t = setInterval(() => void loadMedia().catch(() => undefined), MEDIA_REFRESH_MS);
    return () => clearInterval(t);
  }, [loadMedia]);

  const offerDraft = useCallback(async (id: string, current: { name: string; doc: DesignDoc } | null): Promise<boolean> => {
    const d = readDraft(id);
    if (!d || !d.doc) return false;
    if (current && JSON.stringify({ name: d.name, doc: stripPreview(d.doc) }) === JSON.stringify({ name: current.name, doc: stripPreview(current.doc) })) {
      clearDraft(id);
      return false;
    }
    const restore = await ui.confirm({
      title: 'Restore your unsaved changes?',
      message: `You have unsaved changes to ${id === 'new' ? 'a new slide' : `"${d.name}"`} from ${new Date(d.at).toLocaleString()}. They were not saved to the playlist.`,
      confirmLabel: 'Restore changes',
    });
    if (restore) {
      history.reset(d.doc);
      setName(d.name);
      setChosen(true);
      return true;
    }
    clearDraft(id);
    return false;
  }, [ui, history]);

  // A new slide: offer to pick up where an interrupted session left off.
  // The orientation chooser waits for the answer, so the two dialogs never stack.
  const [draftPending, setDraftPending] = useState(params.id === 'new');
  useEffect(() => {
    if (params.id !== 'new') return;
    void offerDraft('new', null).finally(() => setDraftPending(false));
    // once on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (params.id === 'new') return;
    let live = true;
    setLoading(true);
    urlCache.current.clear();
    api<SavedDesign>(`/api/designs/${params.id}`)
      .then(async (d) => {
        if (!live) return;
        const loaded: DesignDoc = { ...stripPreview(d.document), size: d.document.size ?? { width: d.width, height: d.height } };
        history.reset(loaded);
        setName(d.name);
        setVersion(d.version);
        setDesignId(d.id);
        setMediaCompany(d.company_id);
        setBaseline(JSON.stringify({ name: d.name, doc: loaded }));
        setSelected([]);
        setLoading(false);
        await offerDraft(d.id, { name: d.name, doc: loaded });
      })
      .catch((err) => { if (live) { setLoadError(errorText(err)); setLoading(false); } });
    return () => { live = false; };
    // history.reset / offerDraft are stable enough; params.id is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  // Fonts: wait for the faces this slide uses, then re-measure the text.
  const fontsKey = useMemo(
    () => [...new Set(doc.objects.flatMap((o) => (o.type === 'text' ? [`${o.fontFamily}|${o.bold}|${o.italic}`] : [])))].sort().join(';'),
    [doc.objects],
  );
  useEffect(() => {
    let live = true;
    void ensureFonts(doc).then(() => live && setFontsVersion((v) => v + 1));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontsKey]);

  // Drop selections that no longer exist (after undo, delete, template swap).
  useEffect(() => {
    setSelected((s) => (s.every((id) => doc.objects.some((o) => o.id === id)) ? s : s.filter((id) => doc.objects.some((o) => o.id === id))));
  }, [doc.objects]);

  // ── dirty tracking, drafts & leave guard ───────────────────────────────────────────────
  const snapshot = useMemo(() => JSON.stringify({ name, doc: stripPreview(doc) }), [name, doc]);
  const dirty = designId
    ? baseline !== null && snapshot !== baseline
    : chosen && (doc.objects.length > 0 || doc.background.color !== '#ffffff' || !!doc.background.mediaId);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (!dirty || !canEdit) return;
    const t = setTimeout(() => writeDraft(key, { name, doc: stripPreview(doc), at: Date.now() }), DRAFT_DELAY_MS);
    return () => clearTimeout(t);
  }, [dirty, canEdit, snapshot, key, name, doc]);

  // ── zoom ───────────────────────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = work.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setArea({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [wide, chosen, loading]);
  const fit = clamp(Math.min((area.w - 96) / slide.width, (area.h - 96) / slide.height), 0.05, 2);
  const zoom = zoomMode === 'fit' ? fit : zoomMode;
  const zoomBy = (dir: 1 | -1) => setZoomMode(clamp(Math.round(zoom * (dir > 0 ? 1.25 : 0.8) * 100) / 100, 0.1, 3));

  // ── document edits (all no-ops for view-only users) ────────────────────────────────────
  const commit = useCallback((next: DesignDoc, k?: string) => { if (canEdit) history.set(next, k); }, [history, canEdit]);

  const update = useCallback((patches: Patch[], k?: string) => {
    if (patches.length === 0) return;
    const map = new Map(patches.map((p) => [p.id, p.patch]));
    commit({ ...doc, objects: doc.objects.map((o) => (map.has(o.id) ? ({ ...o, ...map.get(o.id) } as Obj) : o)) }, k);
  }, [doc, commit]);

  const addObjs = (objs: Obj[]) => {
    // New things are dropped in the middle of the slide; step aside if something already sits there,
    // so adding a clock and then the weather does not stack them on one spot.
    const taken = [...doc.objects];
    const placed = objs.map((o) => {
      let n = o;
      for (let i = 0; i < 12 && taken.some((e) => Math.abs(e.x - n.x) < 8 && Math.abs(e.y - n.y) < 8); i++) {
        n = { ...n, x: n.x + 56, y: n.y + 56 };
      }
      taken.push(n);
      return n;
    });
    commit({ ...doc, objects: [...doc.objects, ...placed] });
    setSelected(placed.map((o) => o.id));
  };
  const addText = (preset: 'heading' | 'subheading' | 'body') => {
    const o = makeText(slide, preset);
    addObjs([o]);
    setEditing(o.id);
  };
  const addShape = (k: 'rect' | 'ellipse' | 'line') => addObjs([makeShape(slide, k)]);
  const addWidget = (k: WidgetObj['kind']) => addObjs([makeWidget(slide, k)]);
  const live = isLiveDoc(doc);
  const [previewing, setPreviewing] = useState(false);
  const mediaMap = useMemo(() => Object.fromEntries(media.map((m) => [m.id, m.url])), [media]);

  const selection = doc.objects.filter((o) => selected.includes(o.id));
  const removeIds = (ids: string[]) => {
    if (ids.length === 0) return;
    commit({ ...doc, objects: doc.objects.filter((o) => !ids.includes(o.id)) });
    setSelected([]);
  };
  const deleteSelected = () => removeIds(selected);
  const duplicate = () => {
    if (selection.length === 0) return;
    addObjs(selection.map((o) => cloneObj(o)));
  };
  const toggleLock = (ids = selected) => {
    const targets = doc.objects.filter((o) => ids.includes(o.id));
    const lock = targets.some((o) => !o.locked);
    update(targets.map((o) => ({ id: o.id, patch: { locked: lock } })));
  };

  const reorder = (order: Order) => {
    const ids = new Set(selected);
    const rest = doc.objects.filter((o) => !ids.has(o.id));
    const picked = doc.objects.filter((o) => ids.has(o.id));
    let objects: Obj[];
    if (order === 'front') objects = [...rest, ...picked];
    else if (order === 'back') objects = [...picked, ...rest];
    else {
      objects = [...doc.objects];
      const dir = order === 'forward' ? 1 : -1;
      const idx = dir > 0 ? [...objects.keys()].reverse() : [...objects.keys()];
      for (const i of idx) {
        const j = i + dir;
        if (ids.has(objects[i]!.id) && j >= 0 && j < objects.length && !ids.has(objects[j]!.id)) {
          [objects[i], objects[j]] = [objects[j]!, objects[i]!];
        }
      }
    }
    commit({ ...doc, objects });
  };
  const moveLayer = (id: string, dir: 1 | -1) => {
    const i = doc.objects.findIndex((o) => o.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= doc.objects.length) return;
    const objects = [...doc.objects];
    [objects[i], objects[j]] = [objects[j]!, objects[i]!];
    commit({ ...doc, objects });
  };

  const align = (kind: AlignKind) => {
    const patches: Patch[] = [];
    for (const o of selection) {
      if (o.locked) continue; // locked means "do not move", including by Align
      const b = canvas.current?.bounds(o.id);
      if (!b) continue;
      let dx = 0, dy = 0;
      if (kind === 'left') dx = -b.x;
      if (kind === 'centerH') dx = (slide.width - b.width) / 2 - b.x;
      if (kind === 'right') dx = slide.width - b.width - b.x;
      if (kind === 'top') dy = -b.y;
      if (kind === 'centerV') dy = (slide.height - b.height) / 2 - b.y;
      if (kind === 'bottom') dy = slide.height - b.height - b.y;
      patches.push({ id: o.id, patch: { x: Math.round(o.x + dx), y: Math.round(o.y + dy) } });
    }
    update(patches);
  };

  // ── pictures ───────────────────────────────────────────────────────────────────────────
  // Links are remembered per picture for the whole session: an image already on the canvas keeps
  // its (cached) link even after the list is refreshed, so nothing reloads or flickers.
  const mediaUrl = useCallback((id: string) => {
    const m = media.find((x) => x.id === id);
    if (!m) return undefined;
    const known = urlCache.current.get(id);
    if (known) return known;
    urlCache.current.set(id, m.url);
    return m.url;
  }, [media]);

  const placeImage = async (m: MediaItem, mode: 'layer' | 'background') => {
    if (mode === 'background') {
      commit({ ...doc, background: { ...doc.background, mediaId: m.id } });
      return;
    }
    const dim = await measure(m.url);
    addObjs([makeImage(slide, m.id, dim?.w ?? 800, dim?.h ?? 600)]);
  };
  const upload = async (file: File, mode: 'layer' | 'background') => {
    if (!canEdit) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const created = await api<MediaItem>(`/api/companies/${mediaCompany}/media`, { formData: fd });
      const list = await loadMedia();
      const m = list.find((x) => x.id === created.id);
      if (m?.kind === 'image') await placeImage(m, mode);
      ui.toast('Image uploaded', 'ok');
    } catch (err) {
      ui.toast(errorText(err), 'error');
    } finally {
      setUploading(false);
    }
  };

  /**
   * Publishing a slide with a picture that cannot be shown would bake a placeholder into what
   * the TVs display. Returns the document to publish, or null when the user backs out.
   */
  const resolveImages = async (): Promise<DesignDoc | null> => {
    const handle = canvas.current;
    if (!handle) return null;
    let check = await handle.checkImages();
    if (check.broken.length > 0) {
      // They exist but did not load: usually an expired link. Fetch fresh links and look again.
      for (const id of check.broken) urlCache.current.delete(id);
      await loadMedia();
      await pause(120);
      check = await canvas.current!.checkImages();
      if (check.broken.length > 0) {
        await ui.notice(
          `${check.broken.length} image${check.broken.length === 1 ? '' : 's'} on this slide could not be loaded, so the slide was not saved. Check your connection and try again.`,
          'Images did not load',
        );
        return null;
      }
    }
    if (check.missing.length === 0) return doc;
    const gone = new Set(check.missing);
    const ok = await ui.confirm({
      title: 'Some images were deleted',
      message: `${check.missing.length} image${check.missing.length === 1 ? ' on this slide has' : 's on this slide have'} been deleted from the library. Remove ${check.missing.length === 1 ? 'it' : 'them'} from the slide and continue?`,
      confirmLabel: 'Remove and continue',
      danger: true,
    });
    if (!ok) return null;
    const cleaned: DesignDoc = {
      ...doc,
      background: gone.has(doc.background.mediaId ?? '') ? { ...doc.background, mediaId: null } : doc.background,
      objects: doc.objects.filter((o) => !(o.type === 'image' && gone.has(o.mediaId))),
    };
    commit(cleaned);
    setSelected([]);
    await pause(150); // let the canvas redraw without them before it is rendered
    return cleaned;
  };

  // ── templates ──────────────────────────────────────────────────────────────────────────
  const applyTemplate = async (id: string) => {
    if (!canEdit) return;
    if (doc.objects.length > 0 && !(await ui.ask('Replace this slide with the template? Your current design will be replaced (you can undo).', { confirmLabel: 'Use template' }))) return;
    try {
      const t = await api<SavedDesign>(`/api/designs/${id}`);
      // The size travels inside the document, so Undo brings the old orientation back too.
      commit({ ...stripPreview(t.document), size: { width: t.width, height: t.height } });
      setSelected([]);
      setZoomMode('fit');
      ui.toast(`Applied "${t.name}"`, 'ok');
    } catch (err) {
      ui.toast(errorText(err), 'error');
    }
  };
  const deleteTemplate = async (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!(await ui.ask(`Delete template "${t?.name ?? ''}"? Slides made from it are not affected.`, { danger: true, confirmLabel: 'Delete template' }))) return;
    try {
      await api(`/api/designs/${id}`, { method: 'DELETE' });
      await loadTemplates();
    } catch (err) {
      ui.toast(errorText(err), 'error');
    }
  };
  const saveAsTemplate = async () => {
    const tname = (await ui.prompt({
      title: 'Save as template',
      label: 'Template name',
      initial: name,
      confirmLabel: 'Save template',
      hint: 'A template keeps this layout, text and images so you can start new slides from it.',
    }))?.trim();
    if (!tname) return;
    try {
      setEditing(null);
      const clean = await resolveImages();
      if (!clean) return;
      const preview = await canvas.current!.exportPreview(360);
      await api(`/api/companies/${mediaCompany}/design-templates`, {
        body: { name: tname, width: slide.width, height: slide.height, document: { ...stripPreview(clean), preview } },
      });
      await loadTemplates();
      setTab('templates');
      ui.toast('Template saved', 'ok');
    } catch (err) {
      ui.toast(errorText(err), 'error');
    }
  };

  // ── save / leave ───────────────────────────────────────────────────────────────────────
  const save = async (): Promise<boolean> => {
    if (!canEdit || savingRef.current || !canvas.current) return false;
    savingRef.current = true; // a ref, so two quick Ctrl+S presses cannot both get through before state updates
    setSaving(true);
    setEditing(null);
    setSelected([]);
    try {
      const clean = await resolveImages();
      if (!clean) return false;
      await ensureFonts(clean);
      const blob = await canvas.current.exportPng();
      const cleanName = name.trim() || 'Untitled slide';
      const body = JSON.stringify(stripPreview(clean));

      const send = async (force: boolean) => {
        const form = new FormData();
        form.append('name', cleanName);
        form.append('doc', body);
        form.append('width', String(slide.width));
        form.append('height', String(slide.height));
        if (designId) {
          form.append('baseVersion', String(version));
          if (force) form.append('force', '1');
        } else {
          if (params.playlist) form.append('playlistId', params.playlist);
          form.append('durationMs', '10000');
        }
        form.append('file', blob, `${cleanName}.png`); // the file goes last: fields before it are only readable then
        return api<{ id: string; version: number; live?: boolean }>(
          designId ? `/api/designs/${designId}` : `/api/companies/${mediaCompany}/designs`,
          { method: designId ? 'PUT' : 'POST', formData: form },
        );
      };

      let saved;
      try {
        saved = await send(false);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        const overwrite = await ui.confirm({
          title: 'Someone else changed this slide',
          message: 'It was saved by someone else after you opened it. Overwrite their version with yours? Their changes will be lost.',
          confirmLabel: 'Overwrite',
          danger: true,
        });
        if (!overwrite) return false;
        saved = await send(true);
      }
      setName(cleanName);
      setVersion(saved.version);
      setBaseline(JSON.stringify({ name: cleanName, doc: stripPreview(clean) }));
      clearDraft(key);
      if (!designId) {
        clearDraft('new');
        setDesignId(saved.id);
        // From here on this URL is the saved slide; replaceState keeps Back pointing at the page we came from.
        window.history.replaceState(null, '', `#/designer/${saved.id}${params.playlist ? `?playlist=${params.playlist}` : ''}`);
      }
      void loadMedia();
      ui.toast(
        saved.live
          ? 'Live slide saved - it plays from the server, so the TV must be online'
          : params.playlist && !designId ? 'Slide saved and added to the playlist' : 'Slide saved',
        'ok',
      );
      return true;
    } catch (err) {
      ui.toast(errorText(err), 'error');
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const leave = () => { window.location.hash = returnHash; };
  const back = async () => {
    if (dirty && !(await ui.ask('Discard unsaved changes? Your edits to this slide have not been saved.', { confirmLabel: 'Discard', danger: true }))) return;
    clearDraft(key);
    leave();
  };
  const done = async () => { if (!dirty || (await save())) leave(); };
  const deleteSlide = async () => {
    if (!designId) return;
    if (!(await ui.ask(`Delete slide "${name}"? It is removed from every playlist that uses it. This cannot be undone.`, { danger: true, confirmLabel: 'Delete slide' }))) return;
    try {
      await api(`/api/designs/${designId}`, { method: 'DELETE' });
      setBaseline(snapshot);
      clearDraft(key);
      ui.toast('Slide deleted', 'ok');
      leave();
    } catch (err) {
      ui.toast(errorText(err), 'error');
    }
  };
  const duplicateSlide = async () => {
    if (!designId) return;
    if (dirty) { ui.toast('Save your changes first, then duplicate the slide.', 'info'); return; }
    try {
      const copy = await api<{ id: string }>(`/api/designs/${designId}/duplicate`, {
        body: params.playlist ? { playlistId: params.playlist } : {},
      });
      ui.toast('Duplicated - now editing the copy', 'ok');
      window.location.hash = `#/designer/${copy.id}${params.playlist ? `?playlist=${params.playlist}` : ''}`;
    } catch (err) {
      ui.toast(errorText(err), 'error');
    }
  };

  // ── keyboard ───────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (document.querySelector('.modal-backdrop')) return;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) history.redo(); else history.undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); history.redo(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); return; }
      if (mod && e.key.toLowerCase() === 'c') { clip.current = selection.map((o) => structuredClone(o)); return; }
      if (mod && e.key.toLowerCase() === 'v' && clip.current.length) { e.preventDefault(); addObjs(clip.current.map((o) => cloneObj(o))); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelected(doc.objects.map((o) => o.id)); return; }
      if (mod && e.key === '0') { e.preventDefault(); setZoomMode('fit'); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
      if (e.key === 'Escape') { setSelected([]); return; }
      if (e.key === 'Enter' && canEdit && selection.length === 1 && selection[0]!.type === 'text') { e.preventDefault(); setEditing(selection[0]!.id); return; }
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d && selection.length) {
        e.preventDefault();
        update(selection.filter((o) => !o.locked).map((o) => ({ id: o.id, patch: { x: o.x + d[0]!, y: o.y + d[1]! } })), 'nudge');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Ctrl + wheel zooms the canvas instead of the page.
  useEffect(() => {
    const el = work.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoomMode((z) => clamp((z === 'fit' ? fit : z) * (e.deltaY < 0 ? 1.1 : 0.9), 0.1, 3));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fit, loading, wide, chosen]);

  // ── render ─────────────────────────────────────────────────────────────────────────────
  if (!wide) {
    return (
      <div className="dz-root dz-center">
        <div className="dz-notice">
          <Icon name="landscape" size={34} />
          <h3>Use a larger screen</h3>
          <p>The slide designer needs room for the canvas and tools. Open it on a laptop or desktop, or rotate a tablet to landscape.</p>
          <a className="btn" href={returnHash}><Icon name="back" size={16} /> Back</a>
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="dz-root dz-center">
        <div className="dz-notice">
          <h3>Couldn't open this slide</h3>
          <p>{loadError}</p>
          <a className="btn" href={returnHash}><Icon name="back" size={16} /> Back</a>
        </div>
      </div>
    );
  }
  if (!chosen && draftPending) return <div className="dz-root" />;
  if (!chosen) {
    const start = (sz: SlideSize) => { history.reset(emptyDoc(sz)); setChosen(true); };
    return (
      <div className="dz-root dz-center">
        <Modal title="New slide" onClose={leave}>
          <p className="dz-lead">Which way up is the screen it will play on?</p>
          <div className="dz-orient">
            <button type="button" className="dz-orient-card" onClick={() => start(LANDSCAPE)}>
              <span className="dz-orient-art land" /><b>Landscape</b><small>1920 × 1080 · most TVs</small>
            </button>
            <button type="button" className="dz-orient-card" onClick={() => start(PORTRAIT)}>
              <span className="dz-orient-art port" /><b>Portrait</b><small>1080 × 1920 · rotated screens</small>
            </button>
          </div>
        </Modal>
      </div>
    );
  }

  const status = saving ? 'Saving…' : dirty ? 'Unsaved changes' : designId ? 'All changes saved' : 'New slide';
  const stageW = slide.width * zoom;
  const stageH = slide.height * zoom;
  const readOnly = !canEdit;

  return (
    <div className="dz-root">
      <header className="dz-top">
        <button type="button" className="btn btn-sm" onClick={() => void back()}><Icon name="back" size={16} /> Back</button>
        <input className="dz-name" aria-label="Slide name" value={name} maxLength={200} disabled={readOnly}
          onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        <span className={`dz-status${dirty ? ' dirty' : ''}`} role="status">
          <i />{status}
        </span>
        {live && (
          <span className="dz-live-chip" title="This slide has a widget or animation, so it plays from the server and the TV must be online.">
            <Icon name="play" size={12} /> Live
          </span>
        )}
        <div className="dz-spacer" />
        {live && (
          <button type="button" className="btn btn-sm" onClick={() => { setEditing(null); setPreviewing(true); }}>
            <Icon name="play" size={14} /> Preview
          </button>
        )}
        <div className="dz-group">
          <button type="button" className="dz-icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!history.canUndo} onClick={history.undo}><Icon name="undo" size={17} /></button>
          <button type="button" className="dz-icon" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!history.canRedo} onClick={history.redo}><Icon name="redo" size={17} /></button>
        </div>
        <div className="dz-group">
          <button type="button" className="dz-icon" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(-1)}><Icon name="minus" size={17} /></button>
          <select className="dz-zoom" aria-label="Zoom" value={zoomMode === 'fit' ? 'fit' : String(Math.round(zoom * 100))}
            onChange={(e) => setZoomMode(e.target.value === 'fit' ? 'fit' : Number(e.target.value) / 100)}>
            <option value="fit">Fit ({Math.round(fit * 100)}%)</option>
            {zoomMode !== 'fit' && ![25, 50, 75, 100, 150].includes(Math.round(zoom * 100)) && <option value={Math.round(zoom * 100)}>{Math.round(zoom * 100)}%</option>}
            {[25, 50, 75, 100, 150].map((z) => <option key={z} value={z}>{z}%</option>)}
          </select>
          <button type="button" className="dz-icon" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1)}><Icon name="plus" size={17} /></button>
          <button type="button" className="dz-icon" title="Fit to window (Ctrl+0)" aria-label="Fit to window" onClick={() => setZoomMode('fit')}><Icon name="fit" size={17} /></button>
        </div>
        {canEdit && <Menu label="More slide actions" items={[
          { label: 'Save as template…', onSelect: () => void saveAsTemplate() },
          ...(designId ? [
            { label: 'Duplicate slide', onSelect: () => void duplicateSlide() },
            { label: 'Delete slide', danger: true, separator: true, onSelect: () => void deleteSlide() },
          ] : []),
        ]} />}
        {canEdit && (
          <>
            <button type="button" className="btn btn-sm" disabled={saving || (!dirty && !!designId)} onClick={() => void save()}>
              <Icon name="save" size={16} /> Save
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => void done()}>Done</button>
          </>
        )}
      </header>

      <div className="dz-body">
        <nav className="dz-rail" aria-label="Design tools">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={20} /><span>{t.label}</span>
            </button>
          ))}
        </nav>

        <aside className="dz-pane" aria-label={TABS.find((t) => t.id === tab)?.label}>
          <h3 className="dz-pane-title">{TABS.find((t) => t.id === tab)?.label}</h3>
          {readOnly && <div className="dz-ro">You have view-only access, so editing is turned off.</div>}
          {tab === 'elements' && !readOnly && <ElementsPanel onText={addText} onShape={addShape} onWidget={addWidget} />}
          {tab === 'images' && (
            <ImagesPanel media={media} loading={mediaLoading} canEdit={canEdit} uploading={uploading} mode="layer"
              onPick={(m) => void placeImage(m, 'layer')} onUpload={(f) => void upload(f, 'layer')} />
          )}
          {tab === 'background' && (
            <>
              <div className="dz-pane-body" style={{ paddingBottom: 0 }}>
                <Section title="Colour">
                  <ColorField label="Background" value={doc.background.color} onChange={(c) => commit({ ...doc, background: { ...doc.background, color: c } }, 'bg-color')} />
                </Section>
                {doc.background.mediaId && (
                  <button type="button" className="btn btn-sm" onClick={() => commit({ ...doc, background: { ...doc.background, mediaId: null } })}>Remove background image</button>
                )}
                <h4 className="dz-sub">Image</h4>
              </div>
              <ImagesPanel media={media} loading={mediaLoading} canEdit={canEdit} uploading={uploading} mode="background"
                onPick={(m) => void placeImage(m, 'background')} onUpload={(f) => void upload(f, 'background')} />
            </>
          )}
          {tab === 'templates' && (
            <TemplatesPanel templates={templates} loading={templatesLoading} canEdit={canEdit}
              onApply={(id) => void applyTemplate(id)} onDelete={(id) => void deleteTemplate(id)} />
          )}
          {tab === 'layers' && (
            <LayersPanel objects={doc.objects} selected={selected}
              onSelect={(id, add) => setSelected(add ? (selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]) : [id])}
              onLock={(id) => toggleLock([id])} onDelete={(id) => removeIds([id])} onMove={moveLayer} />
          )}
        </aside>

        <main className="dz-work" ref={work} aria-label="Slide canvas">
          {loading ? <div className="dz-loading">Opening slide…</div> : (
            <div className="dz-canvas-area" style={{ width: `max(100%, ${stageW + 96}px)`, height: `max(100%, ${stageH + 96}px)` }}>
              <div className="dz-slide-label">
                <Icon name={isPortrait(slide) ? 'portrait' : 'landscape'} size={14} /> {slide.width} × {slide.height}
              </div>
              <Canvas
                ref={canvas}
                doc={doc}
                size={slide}
                zoom={zoom}
                selected={selected}
                setSelected={setSelected}
                mediaUrl={mediaUrl}
                update={update}
                editing={readOnly ? null : editing}
                setEditing={setEditing}
                fontsVersion={fontsVersion}
              />
              {!readOnly && doc.objects.length === 0 && !doc.background.mediaId && (
                <div className="dz-empty" style={{ width: stageW, height: stageH }}>
                  <div>
                    <b>Start designing</b>
                    <span>Add text, shapes or images from the left, or pick a template.</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>

        {previewing && <LivePreview doc={doc} size={slide} name={name} media={mediaMap} onClose={() => setPreviewing(false)} />}

        <aside className="dz-inspector" aria-label="Properties">
          <Properties
            doc={doc} size={slide} selection={selection} update={update}
            onAlign={align} onOrder={reorder} onDuplicate={duplicate} onDelete={deleteSelected} onLock={() => toggleLock()}
            onBgColor={(c) => commit({ ...doc, background: { ...doc.background, color: c } }, 'bg-color')}
            onClearBgImage={() => commit({ ...doc, background: { ...doc.background, mediaId: null } })}
          />
        </aside>
      </div>
    </div>
  );
}
