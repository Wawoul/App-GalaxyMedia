import { isValidTimezone } from './validators.js';

export const FALLBACK_TIMEZONE = 'Europe/London';

/**
 * The timezone a screen's schedule is evaluated in - the ONE definition, shared by the
 * manifest (what the TV plays), the dashboard ("now playing") and the reports.
 *
 *   1. the screen's own timezone, if valid;
 *   2. otherwise the first of its groups (by name) that has a valid one;
 *   3. otherwise Europe/London.
 *
 * Invalid values (saved before timezones were validated) are skipped, not thrown on:
 * Intl throws on junk, which used to take a screen's manifest or the whole dashboard down.
 */
export function effectiveTimezone(
  screenTz: string | null | undefined,
  groups: { name: string; timezone: string | null }[],
): string {
  if (screenTz && isValidTimezone(screenTz)) return screenTz;
  const sorted = [...groups].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const g of sorted) {
    if (g.timezone && isValidTimezone(g.timezone)) return g.timezone;
  }
  return FALLBACK_TIMEZONE;
}
