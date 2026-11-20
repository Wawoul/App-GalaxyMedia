import { z } from 'zod';

/**
 * The editable source of a slide, as saved by the admin's designer. The server
 * only checks the envelope (version, size limits, shape of each object) - the
 * object properties themselves belong to the editor and are passed through, so
 * adding a font option never needs a server release. What the TVs show is the
 * rendered PNG, never this document.
 */
/** Entrance and looping motion for any object. Anything other than 'none' makes the slide "live". */
export const ANIM_ENTER = ['none', 'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom'] as const;
export const ANIM_LOOP = ['none', 'pulse', 'float', 'blink'] as const;
const animSchema = z.object({
  enter: z.enum(ANIM_ENTER).optional(),
  loop: z.enum(ANIM_LOOP).optional(),
  delayMs: z.number().int().min(0).max(60_000).optional(),
  durationMs: z.number().int().min(100).max(20_000).optional(),
});

const objectSchema = z
  .object({
    id: z.string().min(1).max(64),
    // 'widget' = text the player keeps up to date (clock, date, weather); see the live page.
    type: z.enum(['text', 'rect', 'ellipse', 'line', 'image', 'widget']),
    mediaId: z.string().uuid().nullish(), // image objects only
    anim: animSchema.optional(),
  })
  .passthrough();

export const designDocSchema = z.object({
  v: z.literal(1),
  background: z
    .object({
      color: z.string().max(32),
      mediaId: z.string().uuid().nullish(),
    })
    .passthrough(),
  objects: z.array(objectSchema).max(300),
  // Small JPEG data URL so template cards can show a picture; slides use their rendered image.
  // Only an inline image: anything else (e.g. a remote URL) would be fetched by other users' browsers.
  preview: z.string().regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/).max(80_000).optional(),
  // Slide size, written by the server from the validated columns so the two cannot disagree.
  size: z.object({ width: z.number().int(), height: z.number().int() }).optional(),
});

export type DesignDoc = z.infer<typeof designDocSchema>;

/** Hard cap on the serialised document, so a malformed client cannot bloat the table. */
export const MAX_DESIGN_DOC_BYTES = 512 * 1024;

/** Parses the JSON text of a multipart `doc` field. Throws a 400-style error when invalid. */
export function parseDesignDoc(text: string | undefined): DesignDoc {
  if (!text || text.length > MAX_DESIGN_DOC_BYTES) {
    throw Object.assign(new Error('invalid_design'), { statusCode: 400 });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('invalid_design'), { statusCode: 400 });
  }
  const parsed = designDocSchema.safeParse(raw);
  if (!parsed.success) throw Object.assign(new Error('invalid_design'), { statusCode: 400 });
  return parsed.data;
}

/**
 * Can this slide be a still picture? Not if anything on it changes by itself: a widget, or any
 * object with an entrance or looping animation. Such a slide is "live" and plays from the server.
 */
export function isLiveDoc(doc: DesignDoc): boolean {
  return doc.objects.some(
    (o) =>
      o.type === 'widget' ||
      (!!o.anim && ((!!o.anim.enter && o.anim.enter !== 'none') || (!!o.anim.loop && o.anim.loop !== 'none'))),
  );
}

/** Every library file a design points at (background and image layers), de-duplicated. */
export function referencedMediaIds(doc: DesignDoc): string[] {
  const ids = new Set<string>();
  if (doc.background.mediaId) ids.add(doc.background.mediaId);
  for (const o of doc.objects) if (o.mediaId) ids.add(o.mediaId);
  return [...ids];
}
