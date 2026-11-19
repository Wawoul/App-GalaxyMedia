/**
 * Clean-up of rows that are only useful for a short while, and which hold
 * secrets (a pairing request carries the screen's 5-year device token).
 *
 * Needs Postgres: set TEST_DATABASE_URL (a throwaway database). Skips without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

describeDb('housekeeping', () => {
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  let wipeDeliveredPairingTokens: () => Promise<number>;
  let pruneExpiredRows: () => Promise<{ pairingRequests: number; refreshTokens: number }>;
  let companyId = '';
  let userId = '';

  async function screen(seen: boolean) {
    const { rows } = await query(
      `INSERT INTO screens (company_id, name, device_token_jti, paired_at, last_seen_at)
       VALUES ($1, 'S', gen_random_uuid(), now(), ${seen ? 'now()' : 'NULL'}) RETURNING id`,
      [companyId],
    );
    return rows[0]!.id as string;
  }
  async function pairing(screenId: string | null, expiresSql = `now() + interval '10 minutes'`) {
    const { rows } = await query(
      `INSERT INTO pairing_requests (code, expires_at, screen_id, device_token)
       VALUES (substr(md5(random()::text), 1, 6), ${expiresSql}, $1, $2) RETURNING id`,
      [screenId, screenId ? 'secret-device-token' : null],
    );
    return rows[0]!.id as string;
  }
  // null = the row exists with its token wiped; 'ROW-GONE' = the row itself was deleted.
  const tokenOf = async (id: string) => {
    const row = (await query('SELECT device_token FROM pairing_requests WHERE id = $1', [id])).rows[0];
    return row ? (row.device_token as string | null) : 'ROW-GONE';
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('../db/migrate.js');
    const pool = await import('../db/pool.js');
    ({ wipeDeliveredPairingTokens, pruneExpiredRows } = await import('./housekeeping.js'));
    query = pool.query as typeof query;
    await migrate();
    await query('DELETE FROM pairing_requests');
    await query('DELETE FROM refresh_tokens');
    await query('DELETE FROM screens');
    await query('DELETE FROM users');
    await query('DELETE FROM companies');
    companyId = (await query(`INSERT INTO companies (name) VALUES ('HkCo') RETURNING id`)).rows[0]!.id;
    userId = (
      await query(`INSERT INTO users (email, password_hash, display_name, level, role, company_id) VALUES ('hk@test.test', 'x', 'U', 'company', 'viewer', $1) RETURNING id`, [companyId])
    ).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await query('DELETE FROM pairing_requests');
  });

  beforeEach(async () => {
    await query('DELETE FROM pairing_requests');
    await query('DELETE FROM refresh_tokens');
  });

  describe('wipeDeliveredPairingTokens', () => {
    it('removes the stored token once the screen has reported in', async () => {
      const seen = await pairing(await screen(true));
      expect(await wipeDeliveredPairingTokens()).toBe(1);
      expect(await tokenOf(seen)).toBeNull();
    });

    it('keeps the token for a screen that has not called in yet (its poll may have been lost)', async () => {
      const waiting = await pairing(await screen(false));
      expect(await wipeDeliveredPairingTokens()).toBe(0);
      expect(await tokenOf(waiting)).toBe('secret-device-token');
    });

    it('leaves an unclaimed request alone and is safe to run repeatedly', async () => {
      const unclaimed = await pairing(null);
      await pairing(await screen(true));
      await wipeDeliveredPairingTokens();
      expect(await wipeDeliveredPairingTokens()).toBe(0);
      expect(await tokenOf(unclaimed)).toBeNull(); // never had one; row untouched
      expect((await query('SELECT 1 FROM pairing_requests WHERE id = $1', [unclaimed])).rows).toHaveLength(1);
    });
  });

  describe('pruneExpiredRows', () => {
    it('deletes pairing requests a day after they expire, and nothing fresher', async () => {
      const old = await pairing(null, `now() - interval '2 days'`);
      const justExpired = await pairing(null, `now() - interval '5 minutes'`);
      const live = await pairing(null);
      const result = await pruneExpiredRows();
      expect(result.pairingRequests).toBe(1);
      expect(await tokenOf(old)).toBe('ROW-GONE');
      expect((await query('SELECT 1 FROM pairing_requests WHERE id = ANY($1)', [[justExpired, live]])).rows).toHaveLength(2);
    });

    it('deletes expired refresh tokens but keeps revoked-yet-unexpired ones (theft detection needs them)', async () => {
      await query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked) VALUES
           ($1, 'expired', now() - interval '1 day', false),
           ($1, 'rotated-still-valid-window', now() + interval '20 days', true),
           ($1, 'live', now() + interval '20 days', false)`,
        [userId],
      );
      const result = await pruneExpiredRows();
      expect(result.refreshTokens).toBe(1);
      const left = (await query('SELECT token_hash FROM refresh_tokens ORDER BY token_hash')).rows.map((r) => r.token_hash);
      expect(left).toEqual(['live', 'rotated-still-valid-window']);
    });
  });
});
