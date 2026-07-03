import { useEffect, useState } from 'react';
import { api } from '../api';

interface AlertSettingsView {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassSet: boolean;
  smtpFrom: string;
  alertEmails: string;
  telegramTokenSet: boolean;
  telegramChatId: string;
  offlineAlertMinutes: number;
}

export function Alerts() {
  const [settings, setSettings] = useState<AlertSettingsView | null>(null);
  const [smtpPass, setSmtpPass] = useState(''); // write-only; blank = unchanged
  const [telegramToken, setTelegramToken] = useState('');
  // A blank field always means "leave it alone" (the server can't tell blank
  // from untouched) - these are the only way to actually remove a saved secret.
  const [clearSmtpPass, setClearSmtpPass] = useState(false);
  const [clearTelegramToken, setClearTelegramToken] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<AlertSettingsView>('/api/settings/alerts')
      .then(setSettings)
      .catch((err) => setError(err instanceof Error ? err.message : 'failed'));
  }, []);

  if (!settings) return error ? <div className="error">{error}</div> : null;

  const set = (patch: Partial<AlertSettingsView>) => setSettings({ ...settings, ...patch });

  const save = async () => {
    setBusy(true);
    setStatus('');
    setError('');
    try {
      await api('/api/settings/alerts', {
        method: 'PUT',
        body: {
          smtpHost: settings.smtpHost,
          smtpPort: settings.smtpPort,
          smtpUser: settings.smtpUser,
          smtpPass: clearSmtpPass ? '' : smtpPass || null, // null = keep, '' = clear
          smtpFrom: settings.smtpFrom,
          alertEmails: settings.alertEmails,
          telegramToken: clearTelegramToken ? '' : telegramToken || null,
          telegramChatId: settings.telegramChatId,
          offlineAlertMinutes: settings.offlineAlertMinutes,
        },
      });
      setStatus('Saved.');
      setSmtpPass('');
      setTelegramToken('');
      setClearSmtpPass(false);
      setClearTelegramToken(false);
      setSettings(await api<AlertSettingsView>('/api/settings/alerts'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setStatus('Sending test…');
    setError('');
    try {
      const result = await api<{ email: string | null; telegram: string | null }>(
        '/api/settings/alerts/test',
        { body: {} },
      );
      setStatus(
        `Email: ${result.email ?? 'sent ✓'} · Telegram: ${result.telegram ?? 'sent ✓'}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'test failed');
    } finally {
      setBusy(false);
    }
  };

  const field = { display: 'grid', gap: 4 } as const;

  return (
    <>
      <h2>Alerts</h2>
      <div className="panel">
        <div className="muted" style={{ marginBottom: 12 }}>
          When a screen sends no heartbeat for the threshold below, an alert goes out on every
          configured channel; a recovery message follows when it comes back. Applies to all companies.
        </div>
        <div className="row">
          <label style={field}>
            <span className="muted">Offline threshold (minutes)</span>
            <input type="number" min={1} max={1440} value={settings.offlineAlertMinutes} style={{ width: 120 }}
              onChange={(e) => set({ offlineAlertMinutes: Number(e.target.value) })} />
          </label>
        </div>
      </div>

      <div className="panel">
        <strong>Email (SMTP)</strong>
        <div className="row" style={{ marginTop: 10 }}>
          <label style={field}>
            <span className="muted">SMTP host</span>
            <input value={settings.smtpHost} placeholder="smtp.example.com"
              onChange={(e) => set({ smtpHost: e.target.value })} />
          </label>
          <label style={field}>
            <span className="muted">Port</span>
            <input type="number" value={settings.smtpPort} style={{ width: 90 }}
              onChange={(e) => set({ smtpPort: Number(e.target.value) })} />
          </label>
          <label style={field}>
            <span className="muted">Username</span>
            <input value={settings.smtpUser} onChange={(e) => set({ smtpUser: e.target.value })} />
          </label>
          <label style={field}>
            <span className="muted">Password {settings.smtpPassSet && '(saved - blank keeps it)'}</span>
            <input type="password" value={smtpPass} placeholder={settings.smtpPassSet ? '••••••••' : ''}
              disabled={clearSmtpPass}
              onChange={(e) => setSmtpPass(e.target.value)} />
            {settings.smtpPassSet && (
              <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                <input type="checkbox" checked={clearSmtpPass}
                  onChange={(e) => { setClearSmtpPass(e.target.checked); if (e.target.checked) setSmtpPass(''); }} />
                Remove saved password
              </label>
            )}
          </label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <label style={field}>
            <span className="muted">From</span>
            <input value={settings.smtpFrom} placeholder="Galaxy Media <alerts@yourdomain>"
              onChange={(e) => set({ smtpFrom: e.target.value })} style={{ minWidth: 260 }} />
          </label>
          <label style={{ ...field, flex: 1 }}>
            <span className="muted">Send to (comma-separated)</span>
            <input value={settings.alertEmails} placeholder="you@example.com, noc@example.com"
              onChange={(e) => set({ alertEmails: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="panel">
        <strong>Telegram bot</strong>
        <div className="muted" style={{ margin: '6px 0 10px', fontSize: 13 }}>
          Create a bot with <strong>@BotFather</strong> (send it <code>/newbot</code>) and paste the token here.
          Then message your bot (or add it to a group), open
          {' '}<code>api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> in a browser, and copy the
          {' '}<code>chat.id</code> value into the Chat ID field.
        </div>
        <div className="row">
          <label style={field}>
            <span className="muted">Bot token {settings.telegramTokenSet && '(saved - blank keeps it)'}</span>
            <input type="password" value={telegramToken}
              placeholder={settings.telegramTokenSet ? '••••••••' : '123456:ABC-…'}
              disabled={clearTelegramToken}
              onChange={(e) => setTelegramToken(e.target.value)} style={{ minWidth: 260 }} />
            {settings.telegramTokenSet && (
              <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                <input type="checkbox" checked={clearTelegramToken}
                  onChange={(e) => { setClearTelegramToken(e.target.checked); if (e.target.checked) setTelegramToken(''); }} />
                Remove saved token
              </label>
            )}
          </label>
          <label style={field}>
            <span className="muted">Chat ID</span>
            <input value={settings.telegramChatId} placeholder="-1001234567890"
              onChange={(e) => set({ telegramChatId: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="row">
        <button onClick={save} disabled={busy}>Save settings</button>
        <button className="secondary" onClick={test} disabled={busy}>Send test alert</button>
        {status && <span className="muted">{status}</span>}
        {error && <span className="error">{error}</span>}
      </div>
    </>
  );
}
