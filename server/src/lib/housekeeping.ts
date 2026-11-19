import { query } from '../db/pool.js';

/**
 * A claimed pairing request holds the screen's device token (valid for 5 years)
 * so the TV can collect it on its next poll. It is kept until then on purpose: if
 * the response carrying it is lost, the retry must still succeed. But once the
 * screen has actually reported in (it has a last_seen_at) it demonstrably has the
 * token, and leaving a plaintext, working credential in the database - and in
 * every backup of it - helps nobody. Returns how many were cleared.
 */
export async function wipeDeliveredPairingTokens(): Promise<number> {
  const result = await query(
    `UPDATE pairing_requests p SET device_token = NULL
     FROM screens s
     WHERE s.id = p.screen_id AND p.device_token IS NOT NULL AND s.last_seen_at IS NOT NULL`,
  );
  return result.rowCount ?? 0;
}

/**
 * Rows that were only ever useful for a short while and otherwise grow for ever:
 * expired pairing requests (any unauthenticated caller can create them) and
 * expired refresh tokens (one per login and per refresh, forever). A token that
 * was rotated or revoked but has not expired is KEPT - replaying it is how theft
 * is detected, so it must stay until it could no longer be used anyway.
 */
export async function pruneExpiredRows(): Promise<{ pairingRequests: number; refreshTokens: number }> {
  const pairing = await query(`DELETE FROM pairing_requests WHERE expires_at < now() - interval '1 day'`);
  const refresh = await query(`DELETE FROM refresh_tokens WHERE expires_at < now()`);
  return { pairingRequests: pairing.rowCount ?? 0, refreshTokens: refresh.rowCount ?? 0 };
}
