import { z } from 'zod';
import { config } from '../config.js';

const MAX_URL_LENGTH = 2000;

/**
 * May this URL be shown as a playlist "web page" item?
 *
 * Only plain http(s) pages. The players render these in a WebView/iframe, so any
 * other scheme is an attack on the player rather than a web page: `javascript:`
 * and `data:` run script in the web player's own origin (which holds the admin
 * app's stored tokens), and `file:`/`content:` reach files on the device. The
 * old check was just "parses as a URL", which accepts all of those.
 *
 * Also refused: credentials in the URL, and the server's own host - framing the
 * admin app inside the web player is how a same-origin page would be abused.
 */
export function isAllowedItemUrl(raw: string, ownHosts: readonly string[]): boolean {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.hostname === '') return false;
  if (url.username !== '' || url.password !== '') return false;
  return !ownHosts.includes(url.hostname.toLowerCase());
}

const OWN_HOSTS = [new URL(config.BASE_URL).hostname.toLowerCase()];

/** Zod schema for a playlist item URL (see isAllowedItemUrl). */
export const itemUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine((u) => isAllowedItemUrl(u, OWN_HOSTS), {
    message: 'must be an http(s) web page or stream, not this server and without a login in the URL',
  });

/** For rows already stored before this rule existed. */
export const isStoredItemUrlAllowed = (raw: string): boolean => isAllowedItemUrl(raw, OWN_HOSTS);
