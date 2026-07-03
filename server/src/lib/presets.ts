/**
 * Layout presets (SPEC §4): zone geometry as fractions of the screen.
 * The server ships these in the manifest so the player stays dumb about
 * presets; adding one here (plus the UI preview) is all it takes.
 */

export interface ZoneGeometry {
  key: 'main' | 'side' | 'ticker';
  x: number;
  y: number;
  w: number;
  h: number;
}

export const LAYOUT_PRESETS: Record<string, ZoneGeometry[]> = {
  'main-side': [
    { key: 'main', x: 0, y: 0, w: 0.75, h: 1 },
    { key: 'side', x: 0.75, y: 0, w: 0.25, h: 1 },
  ],
  'main-ticker': [
    { key: 'main', x: 0, y: 0, w: 1, h: 0.92 },
    { key: 'ticker', x: 0, y: 0.92, w: 1, h: 0.08 },
  ],
  'main-side-ticker': [
    { key: 'main', x: 0, y: 0, w: 0.75, h: 0.92 },
    { key: 'side', x: 0.75, y: 0, w: 0.25, h: 0.92 },
    { key: 'ticker', x: 0, y: 0.92, w: 1, h: 0.08 },
  ],
  'split-2': [
    { key: 'main', x: 0, y: 0, w: 0.5, h: 1 },
    { key: 'side', x: 0.5, y: 0, w: 0.5, h: 1 },
  ],
};
