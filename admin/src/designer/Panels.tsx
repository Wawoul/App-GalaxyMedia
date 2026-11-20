import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../components/icons';
import { EmptyState, Skeleton } from '../components/ui';
import type { MediaItem } from '../types';
import type { Patch } from './Canvas';
import {
  clamp, DEFAULT_TIMEZONE, ENTER_LABELS, FONTS, isLiveDoc, labelOf, LOOP_LABELS, SWATCHES,
  type Anim, type DesignDoc, type EnterAnim, type LoopAnim, type Obj, type Shadow, type SlideSize, type Stroke, type TextObj, type WidgetObj,
} from './model';
import { COMMON_TIMEZONES, searchPlaces, type Place } from './widgets';

type Update = (patches: Patch[], key?: string) => void;

// ── small controls ───────────────────────────────────────────────────────────────────────

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="dz-section">
      <div className="dz-section-head"><h4>{title}</h4>{action}</div>
      {children}
    </section>
  );
}

export function IconBtn({ icon, label, onClick, active, disabled, danger }: {
  icon: IconName; label: string; onClick: () => void; active?: boolean; disabled?: boolean; danger?: boolean;
}) {
  return (
    <button type="button" className={`dz-icon${active ? ' on' : ''}${danger ? ' dz-danger' : ''}`} title={label} aria-label={label}
      aria-pressed={active === undefined ? undefined : active} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={17} />
    </button>
  );
}

/** A number box that lets you type freely and only pushes valid values upward. */
export function NumberField({ label, value, onChange, min = -9999, max = 9999, step = 1, suffix }: {
  label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; suffix?: string;
}) {
  const [text, setText] = useState(String(Math.round(value * 100) / 100));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(Math.round(value * 100) / 100)); }, [value]);
  return (
    <label className="dz-num">
      <span>{label}</span>
      <input
        inputMode="decimal"
        value={text}
        onFocus={(e) => { focused.current = true; e.currentTarget.select(); }}
        onBlur={() => { focused.current = false; setText(String(Math.round(value * 100) / 100)); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const n = clamp(value + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1), min, max);
            setText(String(n)); onChange(n);
          }
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(clamp(n, min, max));
        }}
      />
      {suffix && <em>{suffix}</em>}
    </label>
  );
}

export function Slider({ label, value, onChange, min, max, step = 1, format }: {
  label: string; value: number; onChange: (n: number) => void; min: number; max: number; step?: number; format?: (n: number) => string;
}) {
  return (
    <label className="dz-slider">
      <span>{label}<b>{format ? format(value) : value}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="dz-color" ref={ref}>
      <button type="button" className="dz-color-btn" aria-label={`${label}: ${value}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <i style={{ background: value }} />
        <span>{label}</span>
        <code>{value.toUpperCase()}</code>
      </button>
      {open && (
        <div className="dz-pop" role="dialog" aria-label={`${label} colour`}>
          <div className="dz-swatches">
            {SWATCHES.map((c) => (
              <button key={c} type="button" className={`dz-swatch${c.toLowerCase() === value.toLowerCase() ? ' on' : ''}`}
                style={{ background: c }} aria-label={c} onClick={() => onChange(c)} />
            ))}
          </div>
          <div className="dz-hex">
            <input type="color" aria-label="Pick any colour" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
              onChange={(e) => onChange(e.target.value)} />
            <input aria-label="Hex colour" value={value} spellCheck={false}
              onChange={(e) => { const v = e.target.value; if (/^#[0-9a-f]{0,6}$/i.test(v)) onChange(v); }} />
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (b: boolean) => void; label: string }) {
  return <label className="dz-toggle"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /> {label}</label>;
}

// ── properties (right panel) ─────────────────────────────────────────────────────────────

export type AlignKind = 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom';
export type Order = 'front' | 'forward' | 'backward' | 'back';

export function Properties({ doc, size, selection, update, onAlign, onOrder, onDuplicate, onDelete, onLock, onBgColor, onClearBgImage }: {
  doc: DesignDoc; size: SlideSize; selection: Obj[]; update: Update;
  onAlign: (k: AlignKind) => void; onOrder: (o: Order) => void;
  onDuplicate: () => void; onDelete: () => void; onLock: () => void;
  onBgColor: (c: string) => void; onClearBgImage: () => void;
}) {
  if (selection.length === 0) {
    return (
      <div className="dz-props">
        <Section title="Slide">
          <div className="dz-meta">{size.width} × {size.height} px · {size.height > size.width ? 'Portrait' : 'Landscape'}</div>
          <ColorField label="Background" value={doc.background.color} onChange={onBgColor} />
          {doc.background.mediaId && (
            <button type="button" className="btn btn-sm" onClick={onClearBgImage}>Remove background image</button>
          )}
        </Section>
        <LiveNote doc={doc} />
        <div className="dz-tip">
          <b>Tips</b>
          <ul>
            <li>Double-click text to edit it in place.</li>
            <li>Hold <kbd>Shift</kbd> to select several things.</li>
            <li>Arrow keys nudge · <kbd>Shift</kbd> + arrows nudge 10 px.</li>
            <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>S</kbd> save.</li>
          </ul>
        </div>
      </div>
    );
  }

  const align = (
    <Section title="Align to slide">
      <div className="dz-iconrow">
        <IconBtn icon="edgeL" label="Align left" onClick={() => onAlign('left')} />
        <IconBtn icon="edgeCH" label="Centre horizontally" onClick={() => onAlign('centerH')} />
        <IconBtn icon="edgeR" label="Align right" onClick={() => onAlign('right')} />
        <IconBtn icon="edgeT" label="Align top" onClick={() => onAlign('top')} />
        <IconBtn icon="edgeCV" label="Centre vertically" onClick={() => onAlign('centerV')} />
        <IconBtn icon="edgeB" label="Align bottom" onClick={() => onAlign('bottom')} />
      </div>
    </Section>
  );

  if (selection.length > 1) {
    return (
      <div className="dz-props">
        <Section title={`${selection.length} items selected`}>
          <div className="dz-iconrow">
            <IconBtn icon="copy" label="Duplicate (Ctrl+D)" onClick={onDuplicate} />
            <IconBtn icon="lock" label="Lock / unlock" onClick={onLock} />
            <IconBtn icon="trash" label="Delete (Del)" danger onClick={onDelete} />
          </div>
        </Section>
        {align}
      </div>
    );
  }

  const o = selection[0]!;
  const set = (patch: Partial<Obj>, key?: string) => update([{ id: o.id, patch }], key ?? `p-${o.id}-${Object.keys(patch).join()}`);
  const text = o.type === 'text' ? o : null;
  const widget = o.type === 'widget' ? o : null;
  const strokeable = o.type === 'rect' || o.type === 'ellipse' ? o : null;

  const stroke = (cur: Stroke | null, apply: (s: Stroke | null) => void) => (
    <Section title="Outline" action={<Toggle on={!!cur} label="" onChange={(b) => apply(b ? { color: '#111111', width: 4 } : null)} />}>
      {cur && (
        <div className="dz-stack">
          <ColorField label="Colour" value={cur.color} onChange={(color) => apply({ ...cur, color })} />
          <Slider label="Width" value={cur.width} min={1} max={40} onChange={(width) => apply({ ...cur, width })} format={(n) => `${n}px`} />
        </div>
      )}
    </Section>
  );

  return (
    <div className="dz-props">
      <Section title={o.type[0]!.toUpperCase() + o.type.slice(1)}>
        <div className="dz-iconrow">
          <IconBtn icon="copy" label="Duplicate (Ctrl+D)" onClick={onDuplicate} />
          <IconBtn icon={o.locked ? 'lock' : 'unlock'} label={o.locked ? 'Unlock' : 'Lock in place'} active={!!o.locked} onClick={onLock} />
          <IconBtn icon="trash" label="Delete (Del)" danger onClick={onDelete} />
        </div>
      </Section>

      {text && <TextProps o={text} set={set} />}
      {widget && <WidgetProps o={widget} set={set} />}

      {strokeable && (
        <>
          <Section title="Fill"><ColorField label="Colour" value={strokeable.fill} onChange={(fill) => set({ fill })} /></Section>
          {stroke(strokeable.stroke, (s) => set({ stroke: s }))}
          {o.type === 'rect' && (
            <Section title="Corners">
              <Slider label="Radius" value={o.radius} min={0} max={Math.round(Math.min(o.width, o.height) / 2)} onChange={(radius) => set({ radius })} format={(n) => `${n}px`} />
            </Section>
          )}
        </>
      )}

      {o.type === 'line' && (
        <Section title="Line">
          <div className="dz-stack">
            <ColorField label="Colour" value={o.color} onChange={(color) => set({ color })} />
            <Slider label="Thickness" value={o.thickness} min={1} max={60} onChange={(thickness) => set({ thickness })} format={(n) => `${n}px`} />
          </div>
        </Section>
      )}

      <Section title="Appearance">
        <Slider label="Opacity" value={Math.round(o.opacity * 100)} min={0} max={100} onChange={(n) => set({ opacity: n / 100 })} format={(n) => `${n}%`} />
      </Section>

      <AnimProps o={o} set={set} />

      <Section title="Position & size">
        <div className="dz-grid2">
          <NumberField label="X" value={o.x} onChange={(x) => set({ x: Math.round(x) })} />
          <NumberField label="Y" value={o.y} onChange={(y) => set({ y: Math.round(y) })} />
          <NumberField label="W" value={o.width} min={o.type === 'text' || o.type === 'widget' ? 60 : 10} onChange={(width) => set({ width: Math.round(width) } as Partial<Obj>)} />
          {o.type !== 'text' && o.type !== 'widget' && o.type !== 'line' && (
            <NumberField label="H" value={o.height} min={10} onChange={(height) => set({ height: Math.round(height) } as Partial<Obj>)} />
          )}
          <NumberField label="∠" value={o.rotation} min={-360} max={360} suffix="°" onChange={(rotation) => set({ rotation })} />
        </div>
      </Section>

      {align}

      <Section title="Layer order">
        <div className="dz-iconrow">
          <IconBtn icon="toFront" label="Bring to front" onClick={() => onOrder('front')} />
          <IconBtn icon="forward" label="Bring forward" onClick={() => onOrder('forward')} />
          <IconBtn icon="backward" label="Send backward" onClick={() => onOrder('backward')} />
          <IconBtn icon="toBack" label="Send to back" onClick={() => onOrder('back')} />
        </div>
      </Section>
    </div>
  );
}

/** A slide that moves or updates itself plays from the server rather than as a picture - say so plainly. */
function LiveNote({ doc }: { doc: DesignDoc }) {
  if (!isLiveDoc(doc)) return null;
  return (
    <div className="dz-live-note" role="note">
      <b><Icon name="play" size={14} /> This is a live slide</b>
      <span>It has a widget or animation, so it plays from the server and the TV must be online. Still slides play from the TV's own storage and work offline.</span>
    </div>
  );
}

/** Motion for any object: how it arrives, and whether it keeps moving. */
function AnimProps({ o, set }: { o: Obj; set: (p: Partial<Obj>, key?: string) => void }) {
  const a: Anim = o.anim ?? {};
  const setAnim = (patch: Anim, key?: string) => set({ anim: { ...a, ...patch } }, key ?? `anim-${o.id}-${Object.keys(patch).join()}`);
  const active = (a.enter && a.enter !== 'none') || (a.loop && a.loop !== 'none');
  return (
    <Section title="Animation">
      <div className="dz-stack">
        <label className="dz-field">
          <span>Entrance</span>
          <select aria-label="Entrance animation" value={a.enter ?? 'none'} onChange={(e) => setAnim({ enter: e.target.value as EnterAnim })}>
            {(Object.keys(ENTER_LABELS) as EnterAnim[]).map((k) => <option key={k} value={k}>{ENTER_LABELS[k]}</option>)}
          </select>
        </label>
        <label className="dz-field">
          <span>While showing</span>
          <select aria-label="Looping animation" value={a.loop ?? 'none'} onChange={(e) => setAnim({ loop: e.target.value as LoopAnim })}>
            {(Object.keys(LOOP_LABELS) as LoopAnim[]).map((k) => <option key={k} value={k}>{LOOP_LABELS[k]}</option>)}
          </select>
        </label>
        {active && (
          <div className="dz-grid2">
            <NumberField label="Delay" value={(a.delayMs ?? 0) / 1000} min={0} max={60} step={0.1} suffix="s" onChange={(s) => setAnim({ delayMs: Math.round(s * 1000) })} />
            <NumberField label="Time" value={(a.durationMs ?? 800) / 1000} min={0.1} max={20} step={0.1} suffix="s" onChange={(s) => setAnim({ durationMs: Math.round(s * 1000) })} />
          </div>
        )}
        {active && <div className="dz-meta">Animated slides play from the server, so the TV must be online.</div>}
      </div>
    </Section>
  );
}

function TimezoneSelect({ value, onChange }: { value: string; onChange: (z: string) => void }) {
  const zones = COMMON_TIMEZONES.includes(value) || value === '' ? COMMON_TIMEZONES : [value, ...COMMON_TIMEZONES];
  return (
    <label className="dz-field">
      <span>Time zone</span>
      <select aria-label="Time zone" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">The screen's own clock</option>
        {zones.map((z) => <option key={z} value={z}>{z.replace('_', ' ')}{z === DEFAULT_TIMEZONE ? ' (UK)' : ''}</option>)}
      </select>
    </label>
  );
}

/** Find a town for the weather widget. Open-Meteo's geocoder, so no account or key. */
function PlaceSearch({ place, onPick }: { place: string; onPick: (p: Place) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); setState('idle'); return; }
    let live = true;
    setState('loading');
    const t = setTimeout(() => {
      searchPlaces(q).then((r) => { if (live) { setResults(r); setState('idle'); } })
        .catch(() => { if (live) setState('error'); });
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return (
    <div className="dz-place">
      <div className="dz-search">
        <Icon name="search" size={15} />
        <input type="search" aria-label="Search for a town" placeholder={`Location: ${place || 'search for a town'}`} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {state === 'loading' && <div className="dz-meta">Searching…</div>}
      {state === 'error' && <div className="dz-meta">Couldn't reach the place search. Check your connection.</div>}
      {state === 'idle' && q.trim().length >= 2 && results.length === 0 && <div className="dz-meta">No places found.</div>}
      {results.length > 0 && (
        <ul className="dz-place-list">
          {results.map((r) => (
            <li key={`${r.lat},${r.lon}`}>
              <button type="button" onClick={() => { onPick(r); setQ(''); setResults([]); }}>
                <b>{r.name}</b><span>{r.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WidgetProps({ o, set }: { o: WidgetObj; set: (p: Partial<Obj>, key?: string) => void }) {
  const title = { clock: 'Clock', date: 'Date', weather: 'Weather' }[o.kind];
  return (
    <>
      <Section title={title}>
        <div className="dz-stack">
          {o.kind === 'clock' && (
            <>
              <div className="seg" role="group" aria-label="Clock format">
                <button type="button" aria-pressed={!o.hour12} onClick={() => set({ hour12: false })}>24-hour</button>
                <button type="button" aria-pressed={o.hour12} onClick={() => set({ hour12: true })}>12-hour</button>
              </div>
              <Toggle on={o.seconds} label="Show seconds" onChange={(seconds) => set({ seconds })} />
              <TimezoneSelect value={o.timezone} onChange={(timezone) => set({ timezone })} />
            </>
          )}
          {o.kind === 'date' && (
            <>
              <label className="dz-field">
                <span>Format</span>
                <select aria-label="Date format" value={o.dateStyle} onChange={(e) => set({ dateStyle: e.target.value as WidgetObj['dateStyle'] })}>
                  <option value="long">Friday 20 November 2026</option>
                  <option value="medium">Fri 20 Nov</option>
                  <option value="short">20/11/2026</option>
                  <option value="weekday">Friday</option>
                </select>
              </label>
              <TimezoneSelect value={o.timezone} onChange={(timezone) => set({ timezone })} />
            </>
          )}
          {o.kind === 'weather' && (
            <>
              <PlaceSearch place={o.place} onPick={(p) => set({ place: p.name, lat: p.lat, lon: p.lon })} />
              <div className="seg" role="group" aria-label="Temperature units">
                <button type="button" aria-pressed={o.units === 'c'} onClick={() => set({ units: 'c' })}>°C</button>
                <button type="button" aria-pressed={o.units === 'f'} onClick={() => set({ units: 'f' })}>°F</button>
              </div>
              <Toggle on={o.showPlace} label="Show the place name" onChange={(showPlace) => set({ showPlace })} />
              <div className="dz-meta">Weather is read live from Open-Meteo, so the TV needs internet access.</div>
            </>
          )}
        </div>
      </Section>
      <TextProps o={o} set={set} />
    </>
  );
}

function TextProps({ o, set }: { o: TextObj | WidgetObj; set: (p: Partial<Obj>, key?: string) => void }) {
  const shadow = (s: Shadow | null) => set({ shadow: s } as Partial<Obj>);
  const isText = o.type === 'text';
  return (
    <>
      <Section title={isText ? 'Text' : 'Style'}>
        {o.type === 'text' && (
          <textarea className="dz-textarea" rows={3} value={o.text} aria-label="Text content"
            onChange={(e) => set({ text: e.target.value }, `text-${o.id}`)} />
        )}
        <select className="dz-font" aria-label="Font" value={o.fontFamily} style={{ fontFamily: `"${o.fontFamily}"` }}
          onChange={(e) => set({ fontFamily: e.target.value })}>
          {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>{f}</option>)}
        </select>
        <div className="dz-row">
          <NumberField label="Size" value={o.fontSize} min={8} max={600} onChange={(n) => set({ fontSize: Math.round(n) })} />
          <div className="dz-iconrow tight">
            <IconBtn icon="bold" label="Bold" active={o.bold} onClick={() => set({ bold: !o.bold })} />
            <IconBtn icon="italic" label="Italic" active={o.italic} onClick={() => set({ italic: !o.italic })} />
            {o.type === 'text' && <IconBtn icon="underline" label="Underline" active={o.underline} onClick={() => set({ underline: !o.underline })} />}
          </div>
        </div>
        <div className="dz-iconrow">
          <IconBtn icon="alignL" label="Align left" active={o.align === 'left'} onClick={() => set({ align: 'left' })} />
          <IconBtn icon="alignC" label="Align centre" active={o.align === 'center'} onClick={() => set({ align: 'center' })} />
          <IconBtn icon="alignR" label="Align right" active={o.align === 'right'} onClick={() => set({ align: 'right' })} />
          {isText && <IconBtn icon="alignJ" label="Justify" active={o.align === 'justify'} onClick={() => set({ align: 'justify' })} />}
        </div>
        <ColorField label="Colour" value={o.fill} onChange={(fill) => set({ fill })} />
        {o.type === 'text' && <Slider label="Line height" value={o.lineHeight} min={0.8} max={2.4} step={0.05} onChange={(lineHeight) => set({ lineHeight })} format={(n) => n.toFixed(2)} />}
      </Section>
      <Section title="Shadow" action={<Toggle on={!!o.shadow} label="" onChange={(b) => shadow(b ? { color: '#000000', x: 4, y: 4, blur: 8 } : null)} />}>
        {o.shadow && (
          <div className="dz-stack">
            <ColorField label="Colour" value={o.shadow.color} onChange={(color) => shadow({ ...o.shadow!, color })} />
            <Slider label="Blur" value={o.shadow.blur} min={0} max={60} onChange={(blur) => shadow({ ...o.shadow!, blur })} />
            <div className="dz-grid2">
              <NumberField label="X" value={o.shadow.x} onChange={(x) => shadow({ ...o.shadow!, x })} />
              <NumberField label="Y" value={o.shadow.y} onChange={(y) => shadow({ ...o.shadow!, y })} />
            </div>
          </div>
        )}
      </Section>
      <Section title="Outline" action={<Toggle on={!!o.stroke} label="" onChange={(b) => set({ stroke: b ? { color: '#ffffff', width: 3 } : null } as Partial<Obj>)} />}>
        {o.stroke && (
          <div className="dz-stack">
            <ColorField label="Colour" value={o.stroke.color} onChange={(color) => set({ stroke: { ...o.stroke!, color } } as Partial<Obj>)} />
            <Slider label="Width" value={o.stroke.width} min={1} max={30} onChange={(width) => set({ stroke: { ...o.stroke!, width } } as Partial<Obj>)} format={(n) => `${n}px`} />
          </div>
        )}
      </Section>
    </>
  );
}

// ── left-hand panels ─────────────────────────────────────────────────────────────────────

export function ElementsPanel({ onText, onShape, onWidget }: {
  onText: (p: 'heading' | 'subheading' | 'body') => void; onShape: (k: 'rect' | 'ellipse' | 'line') => void;
  onWidget: (k: WidgetObj['kind']) => void;
}) {
  return (
    <div className="dz-pane-body">
      <Section title="Text">
        <button type="button" className="dz-preset h1" onClick={() => onText('heading')}>Add a heading</button>
        <button type="button" className="dz-preset h2" onClick={() => onText('subheading')}>Add a subheading</button>
        <button type="button" className="dz-preset h3" onClick={() => onText('body')}>Add some body text</button>
      </Section>
      <Section title="Shapes">
        <div className="dz-tiles">
          <button type="button" className="dz-tile" onClick={() => onShape('rect')}><Icon name="rect" size={26} /><span>Rectangle</span></button>
          <button type="button" className="dz-tile" onClick={() => onShape('ellipse')}><Icon name="ellipse" size={26} /><span>Ellipse</span></button>
          <button type="button" className="dz-tile" onClick={() => onShape('line')}><Icon name="line" size={26} /><span>Line</span></button>
        </div>
      </Section>
      <Section title="Live widgets">
        <div className="dz-tiles">
          <button type="button" className="dz-tile" onClick={() => onWidget('clock')}><Icon name="clock" size={26} /><span>Clock</span></button>
          <button type="button" className="dz-tile" onClick={() => onWidget('date')}><Icon name="schedule" size={26} /><span>Date</span></button>
          <button type="button" className="dz-tile" onClick={() => onWidget('weather')}><Icon name="cloud" size={26} /><span>Weather</span></button>
        </div>
        <div className="dz-meta">Widgets update by themselves on the TV, so the slide plays from the server and the TV must be online.</div>
      </Section>
    </div>
  );
}

export function ImagesPanel({ media, loading, canEdit, uploading, onPick, onUpload, mode }: {
  media: MediaItem[]; loading: boolean; canEdit: boolean; uploading: boolean;
  onPick: (m: MediaItem) => void; onUpload: (f: File) => void; mode: 'layer' | 'background';
}) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const images = media
    .filter((m) => m.kind === 'image')
    .filter((m) => !q || m.original_name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="dz-pane-body">
      <div className="dz-search">
        <Icon name="search" size={15} />
        <input type="search" placeholder="Search your images…" aria-label="Search images" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {canEdit && (
        <>
          <input ref={input} type="file" accept="image/*" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
          <button type="button" className="btn dz-upload" disabled={uploading} onClick={() => input.current?.click()}>
            <Icon name="upload" size={16} /> {uploading ? 'Uploading…' : 'Upload an image'}
          </button>
        </>
      )}
      {loading ? <Skeleton lines={4} /> : images.length === 0 ? (
        <EmptyState icon="image" title={q ? 'No matches' : 'No images yet'}>
          {q ? 'Try a different search.' : 'Upload an image to use it on this slide.'}
        </EmptyState>
      ) : (
        <div className="dz-thumbs" aria-label={mode === 'background' ? 'Choose a background image' : 'Choose an image to add'}>
          {images.map((m) => (
            <button key={m.id} type="button" className="dz-thumb" title={m.original_name} onClick={() => onPick(m)}>
              <img src={m.url} alt={m.original_name} loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TemplatesPanel({ templates, loading, onApply, onDelete, canEdit }: {
  templates: { id: string; name: string; width: number; height: number; preview?: string }[];
  loading: boolean; onApply: (id: string) => void; onDelete: (id: string) => void; canEdit: boolean;
}) {
  return (
    <div className="dz-pane-body">
      {loading ? <Skeleton lines={4} /> : templates.length === 0 ? (
        <EmptyState icon="grid" title="No templates yet">
          Design a slide you like, then choose <b>Save as template</b> from the toolbar to reuse it.
        </EmptyState>
      ) : (
        <div className="dz-templates">
          {templates.map((t) => (
            <div key={t.id} className="dz-template">
              <button type="button" className={`dz-template-img${t.height > t.width ? ' portrait' : ''}`} onClick={() => onApply(t.id)} aria-label={`Use template ${t.name}`}>
                {t.preview ? <img src={t.preview} alt="" /> : <Icon name="template" size={28} />}
              </button>
              <div className="dz-template-meta">
                <span title={t.name}>{t.name}</span>
                {canEdit && <button type="button" className="dz-link" onClick={() => onDelete(t.id)}>Delete</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function LayersPanel({ objects, selected, onSelect, onLock, onDelete, onMove }: {
  objects: Obj[]; selected: string[]; onSelect: (id: string, additive: boolean) => void;
  onLock: (id: string) => void; onDelete: (id: string) => void; onMove: (id: string, dir: 1 | -1) => void;
}) {
  const rows = [...objects].reverse(); // top of the stack first, like every design tool
  if (rows.length === 0) {
    return <div className="dz-pane-body"><EmptyState icon="layers" title="Nothing on this slide">Add text, shapes or images and they appear here.</EmptyState></div>;
  }
  const icon = (o: Obj): IconName =>
    o.type === 'text' ? 'text' : o.type === 'image' ? 'image'
      : o.type === 'widget' ? (o.kind === 'clock' ? 'clock' : o.kind === 'weather' ? 'cloud' : 'schedule')
        : o.type;
  return (
    <div className="dz-pane-body">
      <ul className="dz-layers">
        {rows.map((o, i) => (
          <li key={o.id} className={selected.includes(o.id) ? 'on' : ''}>
            <button type="button" className="dz-layer-main" onClick={(e) => onSelect(o.id, e.shiftKey)}>
              <Icon name={icon(o)} size={16} /><span>{labelOf(o)}</span>
            </button>
            <IconBtn icon="forward" label="Move up" disabled={i === 0} onClick={() => onMove(o.id, 1)} />
            <IconBtn icon="backward" label="Move down" disabled={i === rows.length - 1} onClick={() => onMove(o.id, -1)} />
            <IconBtn icon={o.locked ? 'lock' : 'unlock'} label={o.locked ? 'Unlock' : 'Lock'} active={!!o.locked} onClick={() => onLock(o.id)} />
            <IconBtn icon="trash" label="Delete" danger onClick={() => onDelete(o.id)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
