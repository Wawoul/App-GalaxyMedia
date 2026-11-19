import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from './icons';

/* ── Narrow-viewport hook ───────────────────────────────────────────────── */

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/* ── Modal ──────────────────────────────────────────────────────────────── */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Accessible dialog: Esc closes, Tab stays inside, focus returns to whatever opened it. */
export function Modal({
  title, onClose, children, actions, wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // Prefer a form field over the close button so you can type straight away.
    (node?.querySelector<HTMLElement>('input,select,textarea') ?? node?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && node) {
        const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          <div className="modal-title" id={titleId}>{title}</div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

/* ── Provider: confirm(), prompt() and toasts (no more browser popups) ──── */

interface ConfirmOpts { title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean }
interface PromptOpts { title: string; label: string; initial?: string; confirmLabel?: string; hint?: string }
type ToastKind = 'ok' | 'error' | 'info';
interface ToastItem { id: number; kind: ToastKind; message: string }

interface Ui {
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  prompt: (o: PromptOpts) => Promise<string | null>;
  toast: (message: string, kind?: ToastKind) => void;
  /** Drop-in for window.confirm(message): the first sentence becomes the dialog title. */
  ask: (message: string, o?: { confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  /** Drop-in for window.prompt(message, initial). Resolves null when cancelled. */
  input: (message: string, initial?: string) => Promise<string | null>;
  /** Drop-in for window.alert(message): a dialog with one OK button; text stays selectable. */
  notice: (message: string, title?: string) => Promise<void>;
}

/** "Delete X? It cannot be undone." -> title "Delete X?", message "It cannot be undone." */
function splitMessage(text: string): { title: string; message?: string } {
  const flat = text.trim();
  const q = flat.indexOf('?');
  const d = flat.search(/\.(\s|$)/);
  const cut = q >= 0 && (d < 0 || q < d) ? q + 1 : d >= 0 ? d + 1 : -1;
  if (cut < 0 || cut > 140) return { title: 'Please confirm', message: flat };
  const rest = flat.slice(cut).trim();
  return { title: flat.slice(0, cut), message: rest || undefined };
}

const DESTRUCTIVE = /^(delete|remove|reset|discard|permanently|clear|unpair)/i;

const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('useUi must be used inside <UiProvider>');
  return ui;
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<
    | { type: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
    | { type: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void }
    | { type: 'notice'; title: string; message: string; resolve: () => void }
    | null
  >(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    // Errors stay longer: they are the ones you need time to read.
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);

  const ui = useMemo<Ui>(
    () => ({
      toast,
      confirm: (opts) => new Promise((resolve) => setDialog({ type: 'confirm', opts, resolve })),
      prompt: (opts) => new Promise((resolve) => setDialog({ type: 'prompt', opts, resolve })),
      ask: (text, o) => {
        const { title, message } = splitMessage(text);
        const verb = /^(delete|remove|reset|discard|move|unpair|restart|clear)/i.exec(title)?.[1];
        return new Promise((resolve) =>
          setDialog({
            type: 'confirm', resolve,
            opts: {
              title, message,
              danger: o?.danger ?? DESTRUCTIVE.test(title),
              confirmLabel: o?.confirmLabel ?? (verb ? verb[0]!.toUpperCase() + verb.slice(1).toLowerCase() : 'Confirm'),
            },
          }));
      },
      input: (text, initial) => {
        const { title, message } = splitMessage(text.replace(/:\s*$/, '?'));
        return new Promise((resolve) =>
          setDialog({ type: 'prompt', resolve, opts: { title: title.replace(/\?$/, ''), label: 'Value', initial, hint: message } }));
      },
      notice: (text, title = 'Notice') => new Promise<void>((resolve) => setDialog({ type: 'notice', title, message: text, resolve })),
    }),
    [toast],
  );

  const close = (value: boolean | string | null) => {
    if (!dialog) return;
    if (dialog.type === 'confirm') dialog.resolve(value === true);
    else if (dialog.type === 'notice') dialog.resolve();
    else dialog.resolve(typeof value === 'string' ? value : null);
    setDialog(null);
  };

  return (
    <UiContext.Provider value={ui}>
      {children}
      {dialog?.type === 'confirm' && (
        <Modal
          title={dialog.opts.title}
          onClose={() => close(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
              <button type="button" className={`btn ${dialog.opts.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)}>
                {dialog.opts.confirmLabel ?? 'Confirm'}
              </button>
            </>
          }
        >
          <div className="dialog-message">{dialog.opts.message}</div>
        </Modal>
      )}
      {dialog?.type === 'prompt' && <PromptDialog opts={dialog.opts} onDone={close} />}
      {dialog?.type === 'notice' && (
        <Modal title={dialog.title} onClose={() => close(null)} actions={<button type="button" className="btn btn-primary" onClick={() => close(null)}>OK</button>}>
          <div className="dialog-message" style={{ whiteSpace: 'pre-wrap', userSelect: 'text', overflowWrap: 'anywhere' }}>{dialog.message}</div>
        </Modal>
      )}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <Icon name={t.kind === 'error' ? 'warn' : 'check'} />
            <span>{t.message}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </UiContext.Provider>
  );
}

function PromptDialog({ opts, onDone }: { opts: PromptOpts; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(opts.initial ?? '');
  return (
    <Modal
      title={opts.title}
      onClose={() => onDone(null)}
      actions={
        <>
          <button type="button" className="btn" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" form="gm-prompt-form" className="btn btn-primary" disabled={!value.trim()}>
            {opts.confirmLabel ?? 'Save'}
          </button>
        </>
      }
    >
      <form id="gm-prompt-form" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onDone(value.trim()); }}>
        <label className="form-field">
          <span>{opts.label}</span>
          <input value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {opts.hint && <div className="muted" style={{ marginTop: 8, whiteSpace: 'pre-line' }}>{opts.hint}</div>}
      </form>
    </Modal>
  );
}

/* ── Actions menu (replaces the "Actions…" <select>) ────────────────────── */

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  /** Shown under the label, e.g. why an item is disabled. */
  hint?: string;
  /** Draw a divider above this item. */
  separator?: boolean;
}

export function Menu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number; maxHeight?: number }>({ right: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (!open && btn.current) {
      const r = btn.current.getBoundingClientRect();
      // Fixed positioning so a scrolling table wrapper can never clip the menu. Open on whichever
      // side has more room and cap the height to it, so a long menu scrolls instead of running off-screen.
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const right = Math.max(8, window.innerWidth - r.right);
      setPos(below >= 320 || below >= above
        ? { right, top: r.bottom + 4, maxHeight: below }
        : { right, bottom: window.innerHeight - r.top + 4, maxHeight: above });
    }
    setOpen(!open);
  };

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const els = [...(list.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])];
        const i = els.indexOf(document.activeElement as HTMLElement);
        els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
      }
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  return (
    <>
      <button ref={btn} type="button" className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <Icon name="more" />
      </button>
      {open && (
        <div ref={list} className="menu" role="menu" style={{ position: 'fixed', overflowY: 'auto', ...pos }}>
          {items.map((it) => (
            <div key={it.label}>
              {it.separator && <div className="menu-sep" />}
              <button
                type="button" role="menuitem" disabled={it.disabled}
                className={`menu-item${it.danger ? ' menu-danger' : ''}`}
                onClick={() => { setOpen(false); it.onSelect(); }}
              >
                {it.icon && <Icon name={it.icon} size={16} />}
                <span>
                  {it.label}
                  {it.hint && <small>{it.hint}</small>}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ── Small presentational pieces ────────────────────────────────────────── */

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} size={28} /></div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-wrap" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton" style={{ width: `${92 - i * 11}%` }} />)}
    </div>
  );
}

export function StatusDot({ state }: { state: 'online' | 'offline' | 'unpaired' }) {
  return <span className={`dot dot-${state}`} role="img" aria-label={state} />;
}
