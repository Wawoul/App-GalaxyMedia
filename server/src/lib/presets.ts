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

/** The shape both the create endpoint and the import path validate. */
export interface LayoutZones {
  main?: string | null | undefined;
  side?: string | null | undefined;
  ticker?: { texts: string[] } | null | undefined;
  custom?: unknown[] | null | undefined;
}

/**
 * Returns the missing-zone error key ('zone_side_playlist_required', etc.) for a
 * non-custom preset whose required zones aren't filled in, or null when valid.
 * Shared so import can't create broken layouts the create endpoint would reject.
 */
export function validatePresetZones(preset: string, zones: LayoutZones): string | null {
  if (preset === 'custom') return null;
  const geometry = LAYOUT_PRESETS[preset];
  if (!geometry) return 'unknown_preset';
  for (const zone of geometry) {
    if (zone.key === 'ticker') {
      if (!zones.ticker?.texts.length) return 'ticker_text_required';
    } else if (!zones[zone.key]) {
      return `zone_${zone.key}_playlist_required`;
    }
  }
  return null;
}
