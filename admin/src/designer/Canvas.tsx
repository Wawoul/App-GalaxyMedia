import type Konva from 'konva';
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { Image as KImage, Layer, Line, Rect, Shape, Stage, Text, Transformer } from 'react-konva';
import { isTextual, type DesignDoc, type Obj, type SlideSize, type TextObj, type WidgetObj } from './model';
import { fetchWeather, weatherKey, widgetText, type Weather } from './widgets';

export interface Patch { id: string; patch: Partial<Obj> }

export interface CanvasHandle {
  /** Full-resolution PNG of the slide with no selection chrome. */
  exportPng(): Promise<Blob>;
  /** Small JPEG data URL for template cards. */
  exportPreview(maxWidth: number): Promise<string>;
  /**
   * Which pictures the slide points at cannot be shown: `missing` were deleted from the library,
   * `broken` exist but failed to load (network, expired link). Publishing either bakes a
   * placeholder into the slide the TVs show, so the designer checks this before every save.
   */
  checkImages(): Promise<{ missing: string[]; broken: string[] }>;
  /** Slide-space bounding box of an object (rotation and measured text height included). */
  bounds(id: string): { x: number; y: number; width: number; height: number } | null;
}

interface Props {
  ref?: Ref<CanvasHandle>;
  doc: DesignDoc;
  size: SlideSize;
  zoom: number;
  selected: string[];
  setSelected: (ids: string[]) => void;
  mediaUrl: (mediaId: string) => string | undefined;
  update: (patches: Patch[], key?: string) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
  /** Bumped once fonts finish loading so text is re-measured with the real glyphs. */
  fontsVersion: number;
}

// ── image loading (cached so re-selecting / re-rendering never flickers) ─────────────────
const imageCache = new Map<string, HTMLImageElement>();
function loadImage(src: string): Promise<HTMLImageElement | null> {
  const hit = imageCache.get(src);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { imageCache.set(src, img); resolve(img); };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
function useImg(src?: string): { img: HTMLImageElement | null; failed: boolean } {
  const [state, setState] = useState<{ img: HTMLImageElement | null; failed: boolean }>(() => ({
    img: src ? imageCache.get(src) ?? null : null, failed: !src,
  }));
  useEffect(() => {
    if (!src) { setState({ img: null, failed: true }); return; }
    const cached = imageCache.get(src);
    if (cached) { setState({ img: cached, failed: false }); return; }
    let live = true;
    setState({ img: null, failed: false });
    void loadImage(src).then((img) => live && setState({ img, failed: !img }));
    return () => { live = false; };
  }, [src]);
  return state;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const SNAP_PX = 8; // screen pixels
const GUIDE = '#ff3d9a';

function BackgroundImage({ src, size }: { src?: string; size: SlideSize }) {
  const { img } = useImg(src);
  if (!img) return null;
  // "cover": fill the slide, cropping the overflow centrally.
  const scale = Math.max(size.width / img.width, size.height / img.height);
  const cw = size.width / scale;
  const ch = size.height / scale;
  return (
    <KImage name="bg" image={img} x={0} y={0} width={size.width} height={size.height}
      crop={{ x: (img.width - cw) / 2, y: (img.height - ch) / 2, width: cw, height: ch }} />
  );
}

function ImageNode({ o, src, common }: { o: Extract<Obj, { type: 'image' }>; src?: string; common: Record<string, unknown> }) {
  const { img, failed } = useImg(src);
  if (img) return <KImage {...common} image={img} width={o.width} height={o.height} />;
  return (
    <Rect {...common} width={o.width} height={o.height}
      fill={failed ? 'rgba(239,93,112,0.18)' : 'rgba(150,160,185,0.25)'}
      stroke={failed ? '#ef5d70' : undefined} strokeWidth={failed ? 4 : 0} dash={[16, 10]} />
  );
}

export function Canvas({ ref, doc, size, zoom, selected, setSelected, mediaUrl, update, editing, setEditing, fontsVersion }: Props) {
  const stageRef = useRef<Konva.Stage>(null);
  const layerRef = useRef<Konva.Layer>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const nodes = useRef(new Map<string, Konva.Node>());
  const anchor = useRef<string | null>(null);
  const dragStart = useRef<Map<string, { x: number; y: number }> | null>(null);
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const [chromeHidden, setChromeHidden] = useState(false);

  const byId = useMemo(() => new Map(doc.objects.map((o) => [o.id, o])), [doc.objects]);

  // Widgets show what they will show on the TV: a ticking clock, today's date, the real weather.
  const widgets = useMemo(() => doc.objects.filter((o): o is WidgetObj => o.type === 'widget'), [doc.objects]);
  const [now, setNow] = useState(() => new Date());
  const hasWidgets = widgets.length > 0;
  useEffect(() => {
    if (!hasWidgets) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [hasWidgets]);
  const [weather, setWeather] = useState<Record<string, Weather | null>>({});
  const weatherKeys = widgets.filter((w) => w.kind === 'weather').map(weatherKey).join('|');
  useEffect(() => {
    let live = true;
    for (const w of widgets) {
      if (w.kind === 'weather') void fetchWeather(w).then((r) => live && setWeather((p) => ({ ...p, [weatherKey(w)]: r })));
    }
    return () => { live = false; };
    // widgets are re-read whenever their location/units (the key) change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weatherKeys]);
  const reg = (id: string) => (n: Konva.Node | null) => { if (n) nodes.current.set(id, n); else nodes.current.delete(id); };

  // Attach the transformer to whatever is selected (and unlocked, and not being typed into).
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const picked = selected
      .map((id) => byId.get(id))
      .filter((o): o is Obj => !!o && !o.locked && editing !== o.id)
      .map((o) => nodes.current.get(o.id))
      .filter((n): n is Konva.Node => !!n);
    tr.nodes(picked);
    tr.getLayer()?.batchDraw();
  }, [selected, doc.objects, byId, editing, fontsVersion]);

  const only = selected.length === 1 ? byId.get(selected[0]!) : undefined;
  const anchors = only?.type === 'line' || (only && isTextual(only))
    ? (only.type === 'line'
      ? ['middle-left', 'middle-right']
      : ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right'])
    : selected.length > 1
      ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
      : ['top-left', 'top-center', 'top-right', 'middle-right', 'middle-left', 'bottom-left', 'bottom-center', 'bottom-right'];

  // ── export ───────────────────────────────────────────────────────────────────────────
  const withCleanStage = async <T,>(fn: (stage: Konva.Stage) => Promise<T> | T): Promise<T> => {
    const stage = stageRef.current!;
    setChromeHidden(true);
    // Make sure every picture has arrived before drawing the final frame.
    const urls = [doc.background.mediaId, ...doc.objects.map((o) => (o.type === 'image' ? o.mediaId : null))]
      .map((id) => (id ? mediaUrl(id) : undefined))
      .filter((u): u is string => !!u);
    await Promise.all(urls.map(loadImage));
    await nextFrame();
    try { return await fn(stage); } finally { setChromeHidden(false); }
  };

  useImperativeHandle(ref, () => ({
    checkImages: async () => {
      const ids = [...new Set([doc.background.mediaId, ...doc.objects.map((o) => (o.type === 'image' ? o.mediaId : null))])]
        .filter((id): id is string => !!id);
      const missing: string[] = [];
      const broken: string[] = [];
      for (const id of ids) {
        const url = mediaUrl(id);
        if (!url) missing.push(id);
        else if (!(await loadImage(url))) broken.push(id);
      }
      return { missing, broken };
    },
    bounds: (id: string) => {
      const n = nodes.current.get(id);
      return n && layerRef.current ? n.getClientRect({ relativeTo: layerRef.current, skipShadow: true, skipStroke: true }) : null;
    },
    exportPng: () => withCleanStage(async (stage) => {
      const prev = { w: stage.width(), h: stage.height(), s: stage.scaleX() };
      stage.scale({ x: 1, y: 1 });
      stage.size({ width: size.width, height: size.height });
      stage.draw();
      try {
        // pixelRatio 1: the file is exactly the slide size, whatever the display's DPR is.
        return await stage.toBlob({ mimeType: 'image/png', pixelRatio: 1 }) as Blob;
      } finally {
        stage.scale({ x: prev.s, y: prev.s });
        stage.size({ width: prev.w, height: prev.h });
        stage.draw();
      }
    }),
    exportPreview: (maxWidth: number) => withCleanStage((stage) =>
      stage.toDataURL({ mimeType: 'image/jpeg', quality: 0.72, pixelRatio: maxWidth / (size.width * zoom) })),
  }));

  // ── interaction ──────────────────────────────────────────────────────────────────────
  const pick = (id: string, additive: boolean) => {
    if (additive) setSelected(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
    else if (!selected.includes(id)) setSelected([id]);
  };

  const snapTargets = (skip: Set<string>) => {
    const xs = [0, size.width / 2, size.width];
    const ys = [0, size.height / 2, size.height];
    for (const [id, n] of nodes.current) {
      if (skip.has(id) || !n.isVisible()) continue;
      const r = n.getClientRect({ relativeTo: layerRef.current! });
      xs.push(r.x, r.x + r.width / 2, r.x + r.width);
      ys.push(r.y, r.y + r.height / 2, r.y + r.height);
    }
    return { xs, ys };
  };

  const onDragStart = (id: string) => {
    const ids = selected.includes(id) ? selected : [id];
    dragStart.current = new Map(ids.map((i) => [i, { x: nodes.current.get(i)?.x() ?? 0, y: nodes.current.get(i)?.y() ?? 0 }]));
  };

  const onDragMove = (id: string, e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target;
    const start = dragStart.current;
    if (!start) return;
    const ids = [...start.keys()];
    // Snap the dragged node's box against the slide and other objects.
    const threshold = SNAP_PX / zoom;
    const { xs, ys } = snapTargets(new Set(ids));
    const r = node.getClientRect({ relativeTo: layerRef.current! });
    const edgesX = [r.x, r.x + r.width / 2, r.x + r.width];
    const edgesY = [r.y, r.y + r.height / 2, r.y + r.height];
    let dx = 0, dy = 0, bestX = threshold + 1, bestY = threshold + 1;
    const gv: number[] = [], gh: number[] = [];
    for (const e1 of edgesX) for (const t of xs) { const d = t - e1; if (Math.abs(d) < bestX) { bestX = Math.abs(d); dx = d; } }
    for (const e1 of edgesY) for (const t of ys) { const d = t - e1; if (Math.abs(d) < bestY) { bestY = Math.abs(d); dy = d; } }
    if (bestX <= threshold) { node.x(node.x() + dx); for (const e1 of edgesX) for (const t of xs) if (Math.abs(t - (e1 + dx)) < 0.5) gv.push(t); }
    if (bestY <= threshold) { node.y(node.y() + dy); for (const e1 of edgesY) for (const t of ys) if (Math.abs(t - (e1 + dy)) < 0.5) gh.push(t); }
    setGuides({ v: gv, h: gh });
    // Carry the rest of a multi-selection along with the node being dragged.
    const origin = start.get(id)!;
    const mx = node.x() - origin.x;
    const my = node.y() - origin.y;
    for (const other of ids) {
      if (other === id) continue;
      const s = start.get(other)!;
      nodes.current.get(other)?.position({ x: s.x + mx, y: s.y + my });
    }
  };

  const onDragEnd = () => {
    const start = dragStart.current;
    dragStart.current = null;
    setGuides({ v: [], h: [] });
    if (!start) return;
    const patches: Patch[] = [];
    for (const id of start.keys()) {
      const n = nodes.current.get(id);
      if (n) patches.push({ id, patch: { x: Math.round(n.x()), y: Math.round(n.y()) } });
    }
    update(patches);
  };

  const onTransform = (o: Obj) => {
    // Text resizes by reflowing (side handles change the box width, not the glyph size).
    if (!isTextual(o)) return;
    const node = nodes.current.get(o.id) as Konva.Text | undefined;
    if (!node) return;
    const a = trRef.current?.getActiveAnchor() ?? anchor.current;
    anchor.current = a;
    if (a === 'middle-left' || a === 'middle-right') {
      node.setAttrs({ width: Math.max(60, node.width() * node.scaleX()), scaleX: 1, scaleY: 1 });
    }
  };

  const onTransformEnd = () => {
    const patches: Patch[] = [];
    const a = anchor.current;
    anchor.current = null;
    for (const id of selected) {
      const o = byId.get(id);
      const n = nodes.current.get(id);
      if (!o || !n || o.locked) continue;
      const sx = n.scaleX();
      const sy = n.scaleY();
      n.scaleX(1);
      n.scaleY(1);
      const patch: Partial<Obj> = { x: Math.round(n.x()), y: Math.round(n.y()), rotation: Math.round(n.rotation() * 10) / 10 };
      if (isTextual(o)) {
        const side = a === 'middle-left' || a === 'middle-right';
        const t = patch as Partial<TextObj | WidgetObj>;
        t.width = Math.max(60, Math.round(n.width() * (side ? 1 : sx)));
        if (!side) t.fontSize = Math.max(8, Math.round(o.fontSize * sx));
      } else if (o.type === 'line') {
        (patch as { width: number }).width = Math.max(10, Math.round(o.width * sx));
      } else {
        (patch as { width: number; height: number }).width = Math.max(10, Math.round(o.width * sx));
        (patch as { width: number; height: number }).height = Math.max(10, Math.round(o.height * sy));
      }
      patches.push({ id, patch });
    }
    update(patches);
  };

  const setCursor = (c: string) => { const el = stageRef.current?.container(); if (el) el.style.cursor = c; };

  const common = (o: Obj) => ({
    id: o.id,
    ref: reg(o.id),
    x: o.x, y: o.y, rotation: o.rotation, opacity: o.opacity,
    draggable: !o.locked && editing !== o.id,
    perfectDrawEnabled: false,
    onMouseDown: (e: Konva.KonvaEventObject<MouseEvent>) => pick(o.id, e.evt.shiftKey),
    onTouchStart: () => pick(o.id, false),
    // Double-click (or double-tap) text to type in it. Widgets are not typed into: their text is generated.
    onDblClick: () => { if (o.type === 'text' && !o.locked) setEditing(o.id); },
    onDblTap: () => { if (o.type === 'text' && !o.locked) setEditing(o.id); },
    onDragStart: () => onDragStart(o.id),
    onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => onDragMove(o.id, e),
    onDragEnd,
    onTransform: () => onTransform(o),
    // transform END is handled once on the Transformer (below): Konva also fires it on every
    // attached node, which made a multi-selection commit once per node using stale sizes.
    onMouseEnter: () => setCursor(o.locked ? 'not-allowed' : 'move'),
    onMouseLeave: () => setCursor('default'),
  });

  const stageW = size.width * zoom;
  const stageH = size.height * zoom;

  // ── inline text editing (a real <textarea> laid over the canvas) ──────────────────────
  const editObj = editing ? byId.get(editing) : undefined;
  const taRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta || !editObj || editObj.type !== 'text') return;
    ta.style.height = '0px';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [editObj]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || !editing) return;
    ta.focus();
    if (ta.value.startsWith('Add a') || ta.value.startsWith('Add some')) ta.select();
    else ta.setSelectionRange(ta.value.length, ta.value.length);
    // Only on entering edit mode for a different object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  return (
    <div className="dz-stage-wrap" style={{ width: stageW, height: stageH }}>
      <Stage
        ref={stageRef}
        width={stageW}
        height={stageH}
        scaleX={zoom}
        scaleY={zoom}
        onMouseDown={(e) => {
          if (e.target === e.target.getStage() || e.target.hasName('bg')) { setSelected([]); setEditing(null); }
        }}
        onTouchStart={(e) => {
          if (e.target === e.target.getStage() || e.target.hasName('bg')) { setSelected([]); setEditing(null); }
        }}
      >
        <Layer ref={layerRef}>
          <Rect name="bg" width={size.width} height={size.height} fill={doc.background.color} />
          {doc.background.mediaId && <BackgroundImage src={mediaUrl(doc.background.mediaId)} size={size} />}
          {doc.objects.map((o) => {
            const c = common(o);
            switch (o.type) {
              case 'text':
                return (
                  <Text key={`${o.id}-${fontsVersion}`} {...c} visible={editing !== o.id}
                    text={o.text} width={o.width} wrap="word"
                    fontFamily={o.fontFamily} fontSize={o.fontSize}
                    fontStyle={`${o.italic ? 'italic ' : ''}${o.bold ? 'bold' : 'normal'}`}
                    textDecoration={o.underline ? 'underline' : ''}
                    fill={o.fill} align={o.align} lineHeight={o.lineHeight}
                    shadowEnabled={!!o.shadow} shadowColor={o.shadow?.color} shadowBlur={o.shadow?.blur}
                    shadowOffsetX={o.shadow?.x} shadowOffsetY={o.shadow?.y}
                    strokeEnabled={!!o.stroke} stroke={o.stroke?.color} strokeWidth={o.stroke?.width}
                    fillAfterStrokeEnabled lineJoin="round" />
                );
              case 'widget':
                return (
                  <Text key={`${o.id}-${fontsVersion}`} {...c}
                    text={widgetText(o, now, weather[weatherKey(o)] ?? null)} width={o.width} wrap="word"
                    fontFamily={o.fontFamily} fontSize={o.fontSize}
                    fontStyle={`${o.italic ? 'italic ' : ''}${o.bold ? 'bold' : 'normal'}`}
                    fill={o.fill} align={o.align} lineHeight={1.15}
                    shadowEnabled={!!o.shadow} shadowColor={o.shadow?.color} shadowBlur={o.shadow?.blur}
                    shadowOffsetX={o.shadow?.x} shadowOffsetY={o.shadow?.y}
                    strokeEnabled={!!o.stroke} stroke={o.stroke?.color} strokeWidth={o.stroke?.width}
                    fillAfterStrokeEnabled lineJoin="round" />
                );
              case 'rect':
                return (
                  <Rect key={o.id} {...c} width={o.width} height={o.height} fill={o.fill}
                    cornerRadius={Math.min(o.radius, Math.min(o.width, o.height) / 2)}
                    strokeEnabled={!!o.stroke} stroke={o.stroke?.color} strokeWidth={o.stroke?.width} />
                );
              case 'ellipse':
                return (
                  <Shape key={o.id} {...c} width={o.width} height={o.height} fill={o.fill}
                    strokeEnabled={!!o.stroke} stroke={o.stroke?.color} strokeWidth={o.stroke?.width}
                    sceneFunc={(ctx, shape) => {
                      ctx.beginPath();
                      ctx.ellipse(shape.width() / 2, shape.height() / 2, Math.max(1, shape.width() / 2), Math.max(1, shape.height() / 2), 0, 0, Math.PI * 2);
                      ctx.closePath();
                      ctx.fillStrokeShape(shape);
                    }} />
                );
              case 'line':
                return (
                  <Line key={o.id} {...c} points={[0, 0, o.width, 0]} stroke={o.color} strokeWidth={o.thickness}
                    lineCap="round" hitStrokeWidth={Math.max(o.thickness, 28)} />
                );
              case 'image':
                return <ImageNode key={o.id} o={o} src={mediaUrl(o.mediaId)} common={c} />;
            }
          })}
        </Layer>
        <Layer listening={false}>
          {!chromeHidden && guides.v.map((x) => (
            <Line key={`v${x}`} points={[x, 0, x, size.height]} stroke={GUIDE} strokeWidth={1.5 / zoom} dash={[8 / zoom, 6 / zoom]} />
          ))}
          {!chromeHidden && guides.h.map((y) => (
            <Line key={`h${y}`} points={[0, y, size.width, y]} stroke={GUIDE} strokeWidth={1.5 / zoom} dash={[8 / zoom, 6 / zoom]} />
          ))}
        </Layer>
        <Layer>
          <Transformer
            ref={trRef}
            onTransformEnd={onTransformEnd}
            visible={!chromeHidden}
            rotateEnabled
            rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
            rotationSnapTolerance={4}
            keepRatio={selected.length > 1 || only?.type === 'image'}
            enabledAnchors={anchors}
            borderStroke="#5b8cff"
            anchorStroke="#5b8cff"
            anchorFill="#ffffff"
            anchorSize={Math.max(9, 11 / zoom * zoom)}
            anchorCornerRadius={3}
            borderStrokeWidth={1.5}
            padding={2}
            ignoreStroke
            boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 12 || Math.abs(newBox.height) < 4 ? oldBox : newBox)}
          />
        </Layer>
      </Stage>

      {editObj && editObj.type === 'text' && (
        <textarea
          ref={taRef}
          className="dz-text-edit"
          value={editObj.text}
          spellCheck={false}
          onChange={(e) => update([{ id: editObj.id, patch: { text: e.target.value } }], `text-${editObj.id}`)}
          onBlur={() => setEditing(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }}
          style={{
            left: editObj.x * zoom, top: editObj.y * zoom, width: editObj.width * zoom,
            fontFamily: `"${editObj.fontFamily}", sans-serif`,
            fontSize: editObj.fontSize * zoom,
            fontWeight: editObj.bold ? 700 : 400,
            fontStyle: editObj.italic ? 'italic' : 'normal',
            textDecoration: editObj.underline ? 'underline' : 'none',
            lineHeight: editObj.lineHeight,
            color: editObj.fill,
            textAlign: editObj.align,
            opacity: editObj.opacity,
            transform: `rotate(${editObj.rotation}deg)`,
          }}
        />
      )}
    </div>
  );
}
