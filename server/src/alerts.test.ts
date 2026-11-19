/**
 * The offline-alert loop: an alert that could not be delivered must be retried, not
 * silently dropped. The loop marks a screen as alerted BEFORE sending (so two
 * overlapping runs never double-send), which meant a failed send - SMTP briefly
 * down - left the screen marked and nobody ever told.
 *
 * Needs Postgres: set TEST_DATABASE_URL (a throwaway database). Skips without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

type Send = (subject: string, text: string, companyEmails?: string) => Promise<{ email: string | null; telegram: string | null }>;

describeDb('offline alert loop', () => {
  let query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  let checkOfflineScreens: (send: Send) => Promise<void>;
  let screenId = '';

  const alertedAt = async () => (await query('SELECT offline_alerted_at FROM screens WHERE id = $1', [screenId])).rows[0]!.offline_alerted_at as Date | null;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { migrate } = await import('./db/migrate.js');
    const pool = await import('./db/pool.js');
    ({ checkOfflineScreens } = (await import('./alerts.js')) as unknown as { checkOfflineScreens: typeof checkOfflineScreens });
    query = pool.query as typeof query;
    await migrate();
    await query('DELETE FROM screens');
    await query('DELETE FROM companies');
    await query('DELETE FROM settings');
    // An SMTP channel is configured, so alerts are attempted.
    await query(`INSERT INTO settings (key, value) VALUES ('alerts', $1)`, [
      JSON.stringify({ smtpHost: 'smtp.test.invalid', alertEmails: 'ops@test.test', offlineAlertMinutes: 5 }),
    ]);
    const company = (await query(`INSERT INTO companies (name) VALUES ('AlertCo') RETURNING id`)).rows[0]!.id;
    screenId = (
      await query(
        `INSERT INTO screens (company_id, name, device_token_jti, paired_at, last_seen_at)
         VALUES ($1, 'Lobby', gen_random_uuid(), now(), now() - interval '30 minutes') RETURNING id`,
        [company],
      )
    ).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await query('DELETE FROM settings');
  });

  beforeEach(async () => {
    await query('UPDATE screens SET offline_alerted_at = NULL WHERE id = $1', [screenId]);
  });

  it('keeps the screen marked as alerted once the alert is delivered', async () => {
    const sent: string[] = [];
    await checkOfflineScreens(async (subject) => {
      sent.push(subject);
      return { email: null, telegram: 'telegram not configured' };
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Lobby/);
    expect(await alertedAt()).not.toBeNull();
  });

  it('does not alert twice for the same outage', async () => {
    let calls = 0;
    const ok: Send = async () => { calls++; return { email: null, telegram: 'telegram not configured' }; };
    await checkOfflineScreens(ok);
    await checkOfflineScreens(ok);
    expect(calls).toBe(1);
  });

  it('un-marks the screen when every configured channel failed, so the next pass retries', async () => {
    let calls = 0;
    const down: Send = async () => { calls++; return { email: 'connect ETIMEDOUT', telegram: 'telegram not configured' }; };
    await checkOfflineScreens(down);
    expect(await alertedAt()).toBeNull();

    // ...and it genuinely is retried, then stays marked once it finally gets through.
    await checkOfflineScreens(down);
    expect(calls).toBe(2);
    await checkOfflineScreens(async () => { calls++; return { email: null, telegram: 'telegram not configured' }; });
    expect(await alertedAt()).not.toBeNull();
  });

  it('survives a sender that throws', async () => {
    await expect(checkOfflineScreens(async () => { throw new Error('boom'); })).resolves.toBeUndefined();
    expect(await alertedAt()).toBeNull();
  });
});
