import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, setSession } from '../api';

type Step =
  | { name: 'password' }
  | { name: '2fa'; pendingToken: string }
  | { name: 'enroll'; pendingToken: string; secret?: string; otpauthUrl?: string }
  | { name: 'recovery'; codes: string[] };

interface LoginResponse {
  step: 'done' | '2fa' | '2fa_enroll';
  pendingToken?: string;
  accessToken?: string;
  refreshToken?: string;
  recoveryCodes?: string[];
}

export function Login({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>({ name: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');

  useEffect(() => {
    if (step.name === 'enroll' && step.otpauthUrl) {
      QRCode.toDataURL(step.otpauthUrl, { width: 220, margin: 1 })
        .then(setQrDataUrl)
        .catch(() => setQrDataUrl(''));
    }
  }, [step]);

  const finish = (res: LoginResponse) => {
    setSession(res.accessToken!, res.refreshToken!);
    if (res.recoveryCodes) setStep({ name: 'recovery', codes: res.recoveryCodes });
    else onDone();
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const login = () =>
    run(async () => {
      const res = await api<LoginResponse>('/api/auth/login', { body: { email, password } });
      if (res.step === 'done') finish(res);
      else if (res.step === '2fa') setStep({ name: '2fa', pendingToken: res.pendingToken! });
      else {
        const enroll = await api<{ secret: string; otpauthUrl: string }>('/api/auth/2fa/enroll', {
          body: { pendingToken: res.pendingToken! },
        });
        setStep({ name: 'enroll', pendingToken: res.pendingToken!, ...enroll });
      }
    });

  const verify = (path: string, pendingToken: string) =>
    run(async () => {
      finish(await api<LoginResponse>(path, { body: { pendingToken, code } }));
    });

  return (
    <div className="login-wrap">
      <div className="login">
        <h1>
          Galaxy <span style={{ color: 'var(--accent)' }}>Media</span>
        </h1>

        {step.name === 'password' && (
          <>
            <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            <input
              placeholder="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && login()}
            />
            <button onClick={login} disabled={busy || !email || !password}>
              Sign in
            </button>
          </>
        )}

        {step.name === '2fa' && (
          <>
            <div className="muted">Enter the 6-digit code from your authenticator app (or a recovery code).</div>
            <input placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} autoFocus
              onKeyDown={(e) => e.key === 'Enter' && verify('/api/auth/2fa/verify', step.pendingToken)} />
            <button onClick={() => verify('/api/auth/2fa/verify', step.pendingToken)} disabled={busy || code.length < 6}>
              Verify
            </button>
          </>
        )}

        {step.name === 'enroll' && (
          <>
            <div className="muted">
              Two-factor authentication is required for this account. Scan the QR code with your
              authenticator app (Google Authenticator, Aegis, 1Password…), then enter the current code.
            </div>
            {qrDataUrl && (
              <div style={{ textAlign: 'center' }}>
                <img src={qrDataUrl} alt="Scan with your authenticator app" style={{ borderRadius: 8 }} />
              </div>
            )}
            <div className="muted" style={{ fontSize: 12 }}>
              Can't scan? Enter this secret manually: <strong>{step.secret}</strong>
            </div>
            <input placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            <button onClick={() => verify('/api/auth/2fa/activate', step.pendingToken)} disabled={busy || code.length !== 6}>
              Activate 2FA
            </button>
          </>
        )}

        {step.name === 'recovery' && (
          <>
            <div className="muted">
              Save these one-time recovery codes somewhere safe - they are shown only once.
            </div>
            <div className="qr">{step.codes.join('  ')}</div>
            <button onClick={onDone}>I saved them - continue</button>
          </>
        )}

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
