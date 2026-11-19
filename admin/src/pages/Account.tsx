import { useState } from 'react';
import { api, setSession } from '../api';

/** Friendly text for the API's terse error codes. */
function explain(message: string): string {
  if (message === 'invalid_credentials') return 'That is not your current password.';
  if (message === 'validation') return 'The new password must be at least 12 characters.';
  return message;
}

/**
 * Change your own password. Shown as a normal page, and on its own (`forced`)
 * when an administrator chose the password - the server blocks everything else
 * until it has been replaced.
 */
export function Account({ forced, onChanged }: { forced: boolean; onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const mismatch = again !== '' && next !== again;
  const ready = current !== '' && next.length >= 12 && next === again && !busy;

  const submit = async () => {
    setError('');
    setDone(false);
    setBusy(true);
    try {
      // Changing the password ends every session, so the reply carries a fresh one
      // for this tab to keep using.
      const res = await api<{ accessToken: string; refreshToken: string }>('/api/auth/password', {
        body: { currentPassword: current, newPassword: next },
      });
      setSession(res.accessToken, res.refreshToken);
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(true);
      onChanged();
    } catch (err) {
      setError(explain(err instanceof Error ? err.message : 'failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>{forced ? 'Choose a new password' : 'Account'}</h2>
      {forced && (
        <div className="panel">
          Your password was set by an administrator, so it is not private to you. Choose your own to continue.
        </div>
      )}
      <div className="panel" style={{ maxWidth: 420 }}>
        <strong>Change password</strong>
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          <input type="password" placeholder="Current password" autoComplete="current-password"
            value={current} onChange={(e) => setCurrent(e.target.value)} />
          <input type="password" placeholder="New password (12+ characters)" autoComplete="new-password"
            value={next} onChange={(e) => setNext(e.target.value)} />
          <input type="password" placeholder="New password again" autoComplete="new-password"
            value={again} onChange={(e) => setAgain(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ready && void submit()} />
          {mismatch && <div className="error">The two new passwords do not match.</div>}
          {error && <div className="error">{error}</div>}
          {done && <div className="muted">Password changed. Your other sessions were signed out.</div>}
          <button onClick={() => void submit()} disabled={!ready}>Change password</button>
        </div>
      </div>
    </>
  );
}
