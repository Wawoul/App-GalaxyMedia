/**
 * Light / dark / follow-the-system. The choice lives on <html data-theme>; with no
 * attribute the CSS follows prefers-color-scheme. Storage is a per-browser convenience
 * only, so every access is wrapped - it throws in some private windows.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'gm:theme';

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* not persisted - still applied for this visit */
  }
}

export const nextTheme = (c: ThemeChoice): ThemeChoice => (c === 'system' ? 'light' : c === 'light' ? 'dark' : 'system');
