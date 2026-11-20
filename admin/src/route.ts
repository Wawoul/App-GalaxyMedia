/**
 * Hash routing (#/screens): refresh, Back/Forward and bookmarks work without a router
 * dependency, and the server needs no catch-all route. Pure functions so they are easy
 * to test.
 */
export type Page =
  | 'screens' | 'media' | 'playlists' | 'layouts' | 'schedule' | 'reports'
  | 'companies' | 'users' | 'alerts' | 'system' | 'account' | 'designer';

export const PAGES: readonly Page[] = [
  'screens', 'media', 'playlists', 'layouts', 'schedule', 'reports',
  'companies', 'users', 'alerts', 'system', 'account', 'designer',
];

export const DEFAULT_PAGE: Page = 'screens';

/** "#/media" -> 'media'. Anything unknown (or empty) falls back to the default page. */
export function pageFromHash(hash: string): Page {
  const name = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return (PAGES as readonly string[]).includes(name) ? (name as Page) : DEFAULT_PAGE;
}

export const hashFor = (page: Page): string => `#/${page}`;
