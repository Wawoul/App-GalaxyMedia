import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { safeEqual } from './crypto.js';

/**
 * A live slide is shown by a page the server hosts (`/live.html`). TVs open it as an ordinary
 * playlist "web page" item, which cannot carry a login, so the link itself proves it is allowed:
 * a signature only this server can make, for exactly one slide. The page reveals the slide's
 * contents and nothing else, so an unexpiring link is the right trade - an expiring one would
 * need every TV's playlist rewritten on a schedule.
 */
export const liveSig = (designId: string): string =>
  createHmac('sha256', config.JWT_SECRET).update(`live.${designId}`).digest('base64url').slice(0, 32);

export const verifyLiveSig = (designId: string, sig: string): boolean => safeEqual(sig, liveSig(designId));

/** The playlist-item URL for a live slide. */
export const liveUrl = (designId: string): string =>
  `${config.BASE_URL.replace(/\/$/, '')}/live.html?d=${designId}&s=${liveSig(designId)}`;

/**
 * SQL LIKE pattern matching a live slide's playlist items whatever host the URL was written with
 * (BASE_URL can change; the trigger in migration 019 matches the same way).
 */
export const liveUrlPattern = (designId: string): string => `%/live.html?d=${designId}&s=%`;
