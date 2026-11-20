/**
 * Fonts ship with the app (via @fontsource) rather than loading from Google: the editor's
 * canvas export must use exactly the glyphs the preview showed, and a TV-facing signage
 * product should not depend on a third-party CDN being reachable from an office network.
 * This module is only imported by the lazy-loaded designer chunk.
 */
import '@fontsource/inter/400.css';
import '@fontsource/inter/700.css';
import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/700.css';
import '@fontsource/oswald/400.css';
import '@fontsource/oswald/700.css';
import '@fontsource/anton/400.css';
import '@fontsource/bebas-neue/400.css';
import '@fontsource/playfair-display/400.css';
import '@fontsource/playfair-display/700.css';
import '@fontsource/merriweather/400.css';
import '@fontsource/merriweather/700.css';
import '@fontsource/roboto-slab/400.css';
import '@fontsource/roboto-slab/700.css';
import '@fontsource/lobster/400.css';
import '@fontsource/pacifico/400.css';
import '@fontsource/indie-flower/400.css';

import type { DesignDoc } from './model';

/**
 * Resolves once every face the document uses is loaded, so the first paint and the export
 * never measure text with a fallback font. Never rejects: a font that fails to load just
 * renders with the browser fallback.
 */
export async function ensureFonts(doc: DesignDoc): Promise<void> {
  if (!document.fonts) return;
  const wanted = new Set<string>();
  for (const o of doc.objects) {
    if (o.type === 'text') wanted.add(`${o.italic ? 'italic ' : ''}${o.bold ? 700 : 400} 40px "${o.fontFamily}"`);
  }
  await Promise.all([...wanted].map((spec) => document.fonts.load(spec).catch(() => [])));
}

/** Load one family (both weights) - used when the user picks a font in the panel. */
export async function ensureFamily(family: string): Promise<void> {
  if (!document.fonts) return;
  await Promise.all([400, 700].map((w) => document.fonts.load(`${w} 40px "${family}"`).catch(() => [])));
}
