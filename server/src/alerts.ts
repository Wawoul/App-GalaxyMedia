/**
 * Offline screen alerts (SPEC §7) over two channels: SMTP email and Telegram.
 * Settings live in the DB (managed from the Alerts tab; secrets encrypted),
 * with config.env values as a fallback for headless installs.
 */
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { query } from './db/pool.js';
import { decrypt, encrypt } from './lib/crypto.js';

export interface AlertSettings {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassEnc: string; // encrypted at rest; '' = none
  smtpFrom: string;
  alertEmails: string; // comma separated
  telegramTokenEnc: string; // encrypted at rest; '' = none
  telegramChatId: string;
  offlineAlertMinutes: number;
}

const DEFAULTS: AlertSettings = {
  smtpHost: config.SMTP_HOST ?? '',
  smtpPort: config.SMTP_PORT,
  smtpUser: config.SMTP_USER ?? '',
  smtpPassEnc: config.SMTP_PASS ? encrypt(config.SMTP_PASS) : '',
  smtpFrom: config.SMTP_FROM ?? '',
  alertEmails: config.ALERT_EMAILS ?? '',
  telegramTokenEnc: '',
  telegramChatId: '',
  offlineAlertMinutes: config.OFFLINE_ALERT_MINUTES,
};

let cache: AlertSettings | null = null;

export async function getAlertSettings(): Promise<AlertSettings> {
  if (cache) return cache;
  const { rows } = await query<{ value: Partial<AlertSettings> }>(
    `SELECT value FROM settings WHERE key = 'alerts'`,
  );
  cache = { ...DEFAULTS, ...(rows[0]?.value ?? {}) };
  return cache;
}

export async function saveAlertSettings(next: AlertSettings): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('alerts', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify(next)],
  );
  cache = null;
}

// ── Delivery channels ────────────────────────────────────────────────────────

async function sendEmail(
  s: AlertSettings,
  subject: string,
  text: string,
  extraRecipients = '',
): Promise<string | null> {
  const to = [s.alertEmails, extraRecipients].filter(Boolean).join(', ');
  if (!s.smtpHost || !to) return 'email not configured';
  try {
    const transporter = nodemailer.createTransport({
      host: s.smtpHost,
      port: s.smtpPort,
      secure: s.smtpPort === 465,
      auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPassEnc ? decrypt(s.smtpPassEnc) : '' } : undefined,
    });
    await transporter.sendMail({
      from: s.smtpFrom || s.smtpUser,
      to,
      subject,
      text,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'email failed';
  }
}

async function sendTelegram(s: AlertSettings, text: string): Promise<string | null> {
  if (!s.telegramTokenEnc || !s.telegramChatId) return 'telegram not configured';
  try {
    const token = decrypt(s.telegramTokenEnc);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: s.telegramChatId, text }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { description?: string };
      return body.description ?? `telegram HTTP ${res.status}`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'telegram failed';
  }
}

/**
 * Send on every configured channel. Global recipients always get it; a company's
 * own alert_emails (set in the Companies tab) are added for that company's screens.
 */
export async function sendAlert(
  subject: string,
  text: string,
  companyEmails = '',
): Promise<{ email: string | null; telegram: string | null }> {
  const s = await getAlertSettings();
  const [email, telegram] = await Promise.all([
    sendEmail(s, subject, text, companyEmails),
    sendTelegram(s, `${subject}\n\n${text}`),
  ]);
  return { email, telegram };
}

// ── Offline detection loop ───────────────────────────────────────────────────

async function checkOfflineScreens(): Promise<void> {
  const s = await getAlertSettings();
  const anyChannel = (s.smtpHost && s.alertEmails) || (s.telegramTokenEnc && s.telegramChatId);
  if (!anyChannel) return;

  const { rows } = await query<{
    id: string;
    name: string;
    company_name: string;
    company_alert_emails: string;
    last_seen_at: Date | null;
  }>(
    `UPDATE screens s SET offline_alerted_at = now()
     FROM companies c
     WHERE c.id = s.company_id
       AND s.device_token_jti IS NOT NULL
       AND s.last_seen_at IS NOT NULL
       AND s.last_seen_at < now() - make_interval(mins => $1)
       AND s.offline_alerted_at IS NULL
     RETURNING s.id, s.name, s.last_seen_at, c.name AS company_name, c.alert_emails AS company_alert_emails`,
    [s.offlineAlertMinutes],
  );
  for (const screen of rows) {
    void sendAlert(
      `Screen offline: ${screen.name} (${screen.company_name})`,
      `"${screen.name}" at ${screen.company_name} has sent no heartbeat for over ` +
        `${s.offlineAlertMinutes} minutes (last seen ${screen.last_seen_at?.toISOString() ?? 'unknown'}).\n` +
        `It keeps playing cached content, but check power/network when possible.\n` +
        `Dashboard: ${config.BASE_URL}`,
      screen.company_alert_emails,
    );
  }
}

/** Called from the heartbeat handler when a previously-alerted screen reports in. */
export function notifyRecovery(screenId: string): void {
  void (async () => {
    const { rows } = await query<{ name: string; company_name: string; company_alert_emails: string }>(
      `UPDATE screens s SET offline_alerted_at = NULL
       FROM companies c
       WHERE c.id = s.company_id AND s.id = $1 AND s.offline_alerted_at IS NOT NULL
       RETURNING s.name, c.name AS company_name, c.alert_emails AS company_alert_emails`,
      [screenId],
    );
    const screen = rows[0];
    if (screen) {
      void sendAlert(
        `Screen back online: ${screen.name} (${screen.company_name})`,
        `"${screen.name}" at ${screen.company_name} is reporting heartbeats again.`,
        screen.company_alert_emails,
      );
    }
  })();
}

export function startAlertLoop(log: { info: (msg: string) => void }): void {
  let lastCleanup = 0;
  setInterval(() => {
    void checkOfflineScreens().catch(() => {});
    // Daily housekeeping: proof-of-play retention (90 days).
    if (Date.now() - lastCleanup > 24 * 3600_000) {
      lastCleanup = Date.now();
      void query(`DELETE FROM proof_of_play WHERE played_at < now() - interval '90 days'`).catch(() => {});
    }
  }, 60_000).unref();
  log.info('offline alert loop started (channels configured in the Alerts tab)');
}
