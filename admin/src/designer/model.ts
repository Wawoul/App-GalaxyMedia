/**
 * The slide document. Mirrors server/src/lib/designDoc.ts: the server only checks the
 * envelope (id/type/mediaId per object); everything else here is the editor's own and
 * is passed through untouched. Coordinates are in slide pixels (1920x1080 or 1080x1920),
 * x/y are the top-left of the object before rotation, and rotation pivots on that corner.
 */
export interface Shadow { color: string; x: number; y: number; blur: number }
export interface Stroke { color: string; width: number }

export type EnterAnim = 'none' | 'fade' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down' | 'zoom';
export type LoopAnim = 'none' | 'pulse' | 'float' | 'blink';
/** Motion for any object. Only the live page plays it (a rendered picture cannot move). */
export interface Anim { enter?: EnterAnim; loop?: LoopAnim; delayMs?: number; durationMs?: number }

export const ENTER_LABELS: Record<EnterAnim, string> = {
  none: 'None', fade: 'Fade in', 'slide-left': 'Slide in from left', 'slide-right': 'Slide in from right',
  'slide-up': 'Slide in from bottom', 'slide-down': 'Slide in from top', zoom: 'Zoom in',
};
export const LOOP_LABELS: Record<LoopAnim, string> = { none: 'None', pulse: 'Pulse', float: 'Float up and down', blink: 'Blink' };

interface Base {
  id: string;
  x: number;
  y: number;
  rotation: number;
  opacity: number; // 0..1
  locked?: boolean;
  anim?: Anim;
}

export interface TextObj extends Base {
  type: 'text';
  text: string;
  width: number;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  fill: string;
  align: 'left' | 'center' | 'right' | 'justify';
  lineHeight: number;
  shadow: Shadow | null;
  stroke: Stroke | null;
}
export interface RectObj extends Base {
  type: 'rect';
  width: number;
  height: number;
  fill: string;
  stroke: Stroke | null;
  radius: number;
}
export interface EllipseObj extends Base {
  type: 'ellipse';
  width: number;
  height: number;
  fill: string;
  stroke: Stroke | null;
}
export interface LineObj extends Base {
  type: 'line';
  width: number; // length
  color: string;
  thickness: number;
}
export interface ImageObj extends Base {
  type: 'image';
  mediaId: string;
  width: number;
  height: number;
}

/**
 * Text the player keeps up to date by itself: a clock, today's date, or the weather. Styled like text.
 * Any slide containing one is "live" - it plays from a web page, so the TV needs to be online.
 */
export interface WidgetObj extends Base {
  type: 'widget';
  kind: 'clock' | 'date' | 'weather';
  width: number;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  fill: string;
  align: 'left' | 'center' | 'right';
  shadow: Shadow | null;
  stroke: Stroke | null;
  // clock
  hour12: boolean;
  seconds: boolean;
  // clock and date: an IANA zone such as "Europe/London"; '' follows the screen's own clock
  timezone: string;
  // date
  dateStyle: 'long' | 'medium' | 'short' | 'weekday';
  // weather
  place: string;
  lat: number;
  lon: number;
  units: 'c' | 'f';
  showPlace: boolean;
}

export type Obj = TextObj | RectObj | EllipseObj | LineObj | ImageObj | WidgetObj;

/** Objects drawn as a block of text (they resize by reflowing and scale their font from the corners). */
export const isTextual = (o: Obj): o is TextObj | WidgetObj => o.type === 'text' || o.type === 'widget';

/** Would this slide have to be live? Mirrors the server's isLiveDoc (which is the one that decides). */
export function isLiveDoc(doc: DesignDoc): boolean {
  return doc.objects.some((o) => o.type === 'widget'
    || (!!o.anim && ((!!o.anim.enter && o.anim.enter !== 'none') || (!!o.anim.loop && o.anim.loop !== 'none'))));
}

export interface DesignDoc {
  v: 1;
  /** Part of the document (not separate state) so undo/redo also reverts an orientation change. */
  size?: { width: number; height: number };
  background: { color: string; mediaId: string | null };
  objects: Obj[];
  preview?: string;
}

export interface SlideSize { width: number; height: number }
export const LANDSCAPE: SlideSize = { width: 1920, height: 1080 };
export const PORTRAIT: SlideSize = { width: 1080, height: 1920 };
export const isPortrait = (s: SlideSize) => s.height > s.width;

export const newId = (): string =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).slice(0, 12);

export const emptyDoc = (size: SlideSize = LANDSCAPE): DesignDoc => ({
  v: 1, size: { ...size }, background: { color: '#ffffff', mediaId: null }, objects: [],
});

export const FONTS = [
  'Inter', 'Montserrat', 'Poppins', 'Oswald', 'Anton', 'Bebas Neue',
  'Playfair Display', 'Merriweather', 'Roboto Slab', 'Lobster', 'Pacifico', 'Indie Flower',
] as const;
export const DEFAULT_FONT = 'Inter';

export const SWATCHES = [
  '#000000', '#ffffff', '#6b7280', '#ef4444', '#f97316', '#facc15', '#22c55e', '#14b8a6',
  '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#7f1d1d', '#78350f', '#14532d', '#1e3a8a',
];

type Defaults<T extends Obj> = Omit<T, 'id' | 'type'>;
const base = { rotation: 0, opacity: 1 };

export function makeText(size: SlideSize, preset: 'heading' | 'subheading' | 'body' = 'body', text?: string): TextObj {
  const spec = {
    heading: { fontSize: 120, bold: true, text: 'Add a heading' },
    subheading: { fontSize: 72, bold: true, text: 'Add a subheading' },
    body: { fontSize: 44, bold: false, text: 'Add some body text' },
  }[preset];
  const width = Math.round(size.width * 0.6);
  const d: Defaults<TextObj> = {
    ...base,
    x: Math.round((size.width - width) / 2),
    y: Math.round(size.height / 2 - spec.fontSize),
    width,
    fontFamily: DEFAULT_FONT,
    fontSize: spec.fontSize,
    bold: spec.bold,
    italic: false,
    underline: false,
    fill: '#111111',
    align: 'left',
    lineHeight: 1.15,
    shadow: null,
    stroke: null,
    text: text ?? spec.text,
  };
  return { id: newId(), type: 'text', ...d };
}

export const DEFAULT_TIMEZONE = 'Europe/London';

export function makeWidget(size: SlideSize, kind: WidgetObj['kind']): WidgetObj {
  const fontSize = { clock: 170, date: 76, weather: 84 }[kind];
  const width = Math.round(size.width * (kind === 'clock' ? 0.5 : 0.6));
  return {
    id: newId(), type: 'widget', kind, ...base,
    x: Math.round((size.width - width) / 2), y: Math.round(size.height / 2 - fontSize / 2),
    width, fontFamily: DEFAULT_FONT, fontSize, bold: kind !== 'date', italic: false, fill: '#111111',
    align: 'center', shadow: null, stroke: null,
    hour12: false, seconds: false, timezone: DEFAULT_TIMEZONE, dateStyle: 'long',
    place: 'London', lat: 51.5072, lon: -0.1276, units: 'c', showPlace: true,
  };
}

export function makeShape(size: SlideSize, kind: 'rect' | 'ellipse' | 'line'): Obj {
  const w = Math.round(size.width * 0.25);
  const h = Math.round(w * (kind === 'ellipse' ? 1 : 0.65));
  const x = Math.round((size.width - w) / 2);
  const y = Math.round((size.height - h) / 2);
  if (kind === 'rect') {
    return { id: newId(), type: 'rect', ...base, x, y, width: w, height: h, fill: '#3b82f6', stroke: null, radius: 0 };
  }
  if (kind === 'ellipse') {
    return { id: newId(), type: 'ellipse', ...base, x, y, width: h, height: h, fill: '#f97316', stroke: null };
  }
  return { id: newId(), type: 'line', ...base, x, y: Math.round(size.height / 2), width: w, color: '#111111', thickness: 8 };
}

/** Fit an image of natural size (nw x nh) inside ~60% of the slide, centred. */
export function makeImage(size: SlideSize, mediaId: string, nw: number, nh: number): ImageObj {
  const scale = Math.min((size.width * 0.6) / nw, (size.height * 0.6) / nh, 1.5);
  const width = Math.round(nw * scale);
  const height = Math.round(nh * scale);
  return {
    id: newId(), type: 'image', ...base, mediaId, width, height,
    x: Math.round((size.width - width) / 2), y: Math.round((size.height - height) / 2),
  };
}

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function cloneObj(o: Obj, offset = 40): Obj {
  return { ...structuredClone(o), id: newId(), x: o.x + offset, y: o.y + offset, locked: false };
}

/** Short label for the layers list. */
export function labelOf(o: Obj): string {
  switch (o.type) {
    case 'text': return o.text.replace(/\s+/g, ' ').trim().slice(0, 28) || 'Text';
    case 'rect': return 'Rectangle';
    case 'ellipse': return 'Ellipse';
    case 'line': return 'Line';
    case 'image': return 'Image';
    case 'widget': return { clock: 'Clock', date: 'Date', weather: 'Weather' }[o.kind];
  }
}

export const sameSize = (a: SlideSize, b: SlideSize): boolean => a.width === b.width && a.height === b.height;
