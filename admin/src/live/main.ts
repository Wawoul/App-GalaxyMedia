/**
 * The live slide page. TVs open `/live.html?d=<slide>&s=<signature>` as an ordinary web-page playlist
 * item; this draws that slide from its data, keeps the widgets (clock, date, weather) ticking and
 * plays the animations. It is deliberately plain TypeScript with no framework and avoids newer
 * browser APIs, because it has to run in the (sometimes old) web views inside Android TVs.
 *
 * Everything from the slide's data is put on the page with textContent / DOM properties, never as
 * HTML, so a slide's text can never run script.
 */
import '../designer/fonts'; // pulls in the bundled font files
import './live.css';
import type { DesignDoc, Obj, TextObj, WidgetObj } from '../designer/model';
import { fetchWeather, weatherKey, widgetText, type Weather } from '../designer/widgets';

interface LiveData {
  name: string;
  width: number;
  height: number;
  version: number;
  document: DesignDoc;
  media: Record<string, string>;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const stage = document.getElementById('stage') as HTMLDivElement;
const msg = document.getElementById('msg') as HTMLDivElement;
const params = new URLSearchParams(window.location.search);
const preview = params.get('preview') === '1';

let current: LiveData | null = null;
let widgetEls: { o: WidgetObj; el: HTMLElement }[] = [];
const weather: Record<string, Weather | null> = {};

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && isFinite(v) ? v : fallback);
const px = (v: unknown, fallback = 0): string => `${num(v, fallback)}px`;
const css = (v: unknown, fallback: string): string => (typeof v === 'string' && v.length < 64 ? v : fallback);
const fontFamily = (name: unknown): string => `"${String(name || 'Inter').replace(/["\\]/g, '')}", sans-serif`;

function div(className?: string): HTMLDivElement {
  const d = document.createElement('div');
  if (className) d.className = className;
  return d;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs).forEach((k) => e.setAttribute(k, String(attrs[k])));
  return e;
}

function strokeAttrs(s: { color?: string; width?: number } | null | undefined): Record<string, string | number> {
  return s ? { stroke: css(s.color, '#000'), 'stroke-width': num(s.width, 1) } : { stroke: 'none' };
}

/** Text drawn the way the editor draws it: same font, size, line height, shadow and outline. */
function styleText(el: HTMLElement, o: TextObj | WidgetObj): void {
  const lineHeight = o.type === 'text' ? num(o.lineHeight, 1.15) : 1.15;
  el.style.width = px(o.width, 400);
  el.style.fontFamily = fontFamily(o.fontFamily);
  el.style.fontSize = px(o.fontSize, 48);
  el.style.fontWeight = o.bold ? '700' : '400';
  el.style.fontStyle = o.italic ? 'italic' : 'normal';
  el.style.lineHeight = String(lineHeight);
  el.style.color = css(o.fill, '#111');
  el.style.textAlign = o.align;
  if (o.type === 'text' && o.underline) el.style.textDecoration = 'underline';
  if (o.shadow) el.style.textShadow = `${px(o.shadow.x)} ${px(o.shadow.y)} ${px(o.shadow.blur)} ${css(o.shadow.color, '#000')}`;
  if (o.stroke) {
    // paint-order puts the outline behind the letters, like the editor's fill-after-stroke
    (el.style as unknown as Record<string, string>)['-webkit-text-stroke'] = `${px(o.stroke.width)} ${css(o.stroke.color, '#fff')}`;
    (el.style as unknown as Record<string, string>)['paint-order'] = 'stroke fill';
  }
}

/** One object: position+rotation on the outside, then entrance, then looping motion, then the content. */
function buildObject(o: Obj, data: LiveData): HTMLElement | null {
  let content: HTMLElement | SVGElement | null = null;
  let w = num((o as { width?: number }).width, 100);
  let h: number | null = null; // null = as tall as its content (text)

  switch (o.type) {
    case 'text': {
      const t = div('t');
      t.textContent = o.text;
      styleText(t, o);
      content = t;
      break;
    }
    case 'widget': {
      const t = div('t');
      styleText(t, o);
      t.textContent = widgetText(o, new Date(), weather[weatherKey(o)] || null);
      content = t;
      break;
    }
    case 'rect': {
      h = num(o.height, 100);
      const svg = svgEl('svg', { width: w, height: h });
      const r = Math.min(num(o.radius, 0), Math.min(w, h) / 2);
      svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, rx: r, ry: r, fill: css(o.fill, '#3b82f6'), ...strokeAttrs(o.stroke) }));
      content = svg;
      break;
    }
    case 'ellipse': {
      h = num(o.height, 100);
      const svg = svgEl('svg', { width: w, height: h });
      svg.appendChild(svgEl('ellipse', { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2, fill: css(o.fill, '#f97316'), ...strokeAttrs(o.stroke) }));
      content = svg;
      break;
    }
    case 'line': {
      h = Math.max(1, num(o.thickness, 4));
      const svg = svgEl('svg', { width: w, height: h });
      svg.appendChild(svgEl('line', { x1: 0, y1: 0, x2: w, y2: 0, stroke: css(o.color, '#111'), 'stroke-width': h, 'stroke-linecap': 'round' }));
      content = svg;
      break;
    }
    case 'image': {
      const src = data.media[o.mediaId || ''];
      if (!src) return null; // a deleted picture simply isn't drawn (the editor warns before saving)
      h = num(o.height, 100);
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.style.width = px(w);
      img.style.height = px(h);
      content = img;
      break;
    }
  }
  if (!content) return null;

  const outer = div('o');
  outer.style.left = px(o.x);
  outer.style.top = px(o.y);
  outer.style.opacity = String(num(o.opacity, 1));
  if (o.rotation) outer.style.transform = `rotate(${num(o.rotation, 0)}deg)`;

  const a = o.anim || {};
  const enter = div();
  enter.style.width = px(w);
  if (h !== null) enter.style.height = px(h);
  const loop = div();
  loop.style.width = px(w);
  if (h !== null) loop.style.height = px(h);

  const delay = Math.max(0, num(a.delayMs, 0));
  const dur = Math.max(100, num(a.durationMs, 800));
  const hasEnter = !!a.enter && a.enter !== 'none';
  if (hasEnter) enter.style.animation = `gm-${a.enter} ${dur}ms ease-out ${delay}ms both`;
  if (a.loop && a.loop !== 'none') {
    const period = { pulse: 1600, float: 3200, blink: 1300 }[a.loop] || 1600;
    // a looping object starts moving once it has finished arriving
    loop.style.animation = `gm-${a.loop} ${period}ms ease-in-out ${hasEnter ? delay + dur : delay}ms infinite`;
  }

  loop.appendChild(content);
  enter.appendChild(loop);
  outer.appendChild(enter);
  if (o.type === 'widget') widgetEls.push({ o, el: content as HTMLElement });
  return outer;
}

function fit(): void {
  if (!current) return;
  const s = Math.min(window.innerWidth / current.width, window.innerHeight / current.height);
  const x = (window.innerWidth - current.width * s) / 2;
  const y = (window.innerHeight - current.height * s) / 2;
  stage.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
}

function render(data: LiveData): void {
  current = data;
  widgetEls = [];
  while (stage.firstChild) stage.removeChild(stage.firstChild);
  stage.style.width = px(data.width);
  stage.style.height = px(data.height);
  stage.style.backgroundColor = css(data.document.background && data.document.background.color, '#fff');
  const bg = data.document.background && data.document.background.mediaId;
  if (bg && data.media[bg]) {
    const d = div();
    d.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;background-size:cover;background-position:center;';
    d.style.backgroundImage = `url("${data.media[bg]}")`;
    stage.appendChild(d);
  }
  (data.document.objects || []).forEach((o) => {
    const el = buildObject(o, data);
    if (el) stage.appendChild(el);
  });
  fit();
  stage.className = 'ready';
  msg.textContent = '';
  loadWeather();
}

function tick(): void {
  const now = new Date();
  widgetEls.forEach(({ o, el }) => {
    const text = widgetText(o, now, weather[weatherKey(o)] || null);
    if (el.textContent !== text) el.textContent = text;
  });
}

function loadWeather(): void {
  widgetEls.forEach(({ o }) => {
    if (o.kind !== 'weather') return;
    const key = weatherKey(o);
    fetchWeather(o).then((w) => { weather[key] = w; tick(); });
  });
}

// ── getting the slide ────────────────────────────────────────────────────────────────────
function load(): void {
  const id = params.get('d');
  const sig = params.get('s');
  if (!id || !sig) { msg.textContent = 'Missing slide link'; return; }
  fetch(`/api/live/${encodeURIComponent(id)}?s=${encodeURIComponent(sig)}`, { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then((data: LiveData) => {
      // Redraw only when the slide really changed, so a refresh never restarts a playing animation.
      if (!current || current.version !== data.version) render(data);
    })
    .catch(() => { if (!current) msg.textContent = 'Unable to load this slide'; });
}

window.addEventListener('resize', fit);
setInterval(tick, 1000);
setInterval(loadWeather, 10 * 60 * 1000);

if (preview) {
  // Inside the designer: the editor sends the slide being edited, saved or not.
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    const m = e.data as { type?: string; data?: LiveData } | null;
    if (m && m.type === 'gm-live-doc' && m.data) render(m.data);
  });
  if (window.parent !== window) window.parent.postMessage({ type: 'gm-live-ready' }, window.location.origin);
} else {
  load();
  setInterval(load, 5 * 60 * 1000); // pick up edits (and keep going if the TV leaves this page up for an hour)
}
