import { useEffect, useRef, useState } from 'react';
import { api, uploadWithProgress } from '../api';

interface ApkRelease {
  versionCode: number;
  versionName: string;
  sha256: string;
  sizeBytes: number;
  uploadedAt: string;
  downloadUrl?: string;
}

interface HostStats {
  cpuCores: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  memTotalBytes: number;
  memFreeBytes: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  diskUsedBytes: number;
  osUptimeS: number;
  nodeVersion: string;
  lastBackupAt: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

function formatUptime(s: number): string {
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

/** A stat's value turns red once free space drops below 10%. */
function lowFraction(total: number, free: number): boolean {
  return total > 0 && free / total < 0.1;
}

export function System() {
  const [release, setRelease] = useState<ApkRelease | null>(null);
  const [hostStats, setHostStats] = useState<HostStats | null>(null);
  const [webPlayerEnabled, setWebPlayerEnabled] = useState<boolean | null>(null);
  const [versionCode, setVersionCode] = useState('');
  const [versionName, setVersionName] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<ApkRelease | null>('/api/system/apk')
      .then(setRelease)
      .catch((err) => setError(err instanceof Error ? err.message : 'failed'));
    api<{ webPlayerEnabled: boolean }>('/api/system/settings')
      .then((s) => setWebPlayerEnabled(s.webPlayerEnabled))
      .catch(() => setWebPlayerEnabled(false));
  }, []);

  useEffect(() => {
    const loadStats = () => void api<HostStats>('/api/system/host-stats').then(setHostStats).catch(() => {});
    loadStats();
    const timer = setInterval(loadStats, 15000);
    return () => clearInterval(timer);
  }, []);

  const toggleWebPlayer = async (next: boolean) => {
    setWebPlayerEnabled(next); // optimistic
    try {
      await api('/api/system/settings', { method: 'PUT', body: { webPlayerEnabled: next } });
    } catch (err) {
      setWebPlayerEnabled(!next);
      setError(err instanceof Error ? err.message : 'failed');
    }
  };

  const upload = async () => {
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setError('');
    setStatus('');
    try {
      await uploadWithProgress('/api/system/apk', file, setProgress, {
        versionCode,
        versionName,
      });
      setStatus('Release published. Nothing installs automatically - use "Install latest app update…" per screen on the Screens tab when a tech is on-site.');
      setRelease(await api<ApkRelease | null>('/api/system/apk'));
      setVersionCode('');
      setVersionName('');
      setFileName('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed');
    } finally {
      setProgress(null);
    }
  };

  const memUsed = hostStats ? hostStats.memTotalBytes - hostStats.memFreeBytes : 0;
  const diskUsed = hostStats?.diskUsedBytes ?? 0;

  return (
    <>
      <h2>System</h2>

      <div className="panel">
        <strong>Host</strong>
        {hostStats ? (
          <div className="row" style={{ marginTop: 8, gap: 32, flexWrap: 'wrap' }}>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>CPU load ({hostStats.cpuCores} core{hostStats.cpuCores === 1 ? '' : 's'})</div>
              {/* 1-min load average over core count; can exceed 100% when overloaded */}
              {(() => {
                const pct = Math.round((hostStats.loadAvg1 / Math.max(hostStats.cpuCores, 1)) * 100);
                return <div style={{ color: pct >= 90 ? 'var(--bad)' : undefined }}>{pct}%</div>;
              })()}
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>Memory</div>
              <div style={{ color: lowFraction(hostStats.memTotalBytes, hostStats.memFreeBytes) ? 'var(--bad)' : undefined }}>
                {formatBytes(memUsed)} / {formatBytes(hostStats.memTotalBytes)}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>Disk (media volume)</div>
              <div style={{ color: lowFraction(hostStats.diskTotalBytes, hostStats.diskFreeBytes) ? 'var(--bad)' : undefined }}>
                {hostStats.diskTotalBytes ? `${formatBytes(diskUsed)} / ${formatBytes(hostStats.diskTotalBytes)}` : ' - '}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>Server uptime</div>
              <div>{formatUptime(hostStats.osUptimeS)}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>Node.js</div>
              <div>{hostStats.nodeVersion}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>Last backup</div>
              {/* red once a nightly run has been missed (>26h) */}
              <div style={{
                color: hostStats.lastBackupAt && Date.now() - Date.parse(hostStats.lastBackupAt) > 26 * 3600_000
                  ? 'var(--bad)' : undefined,
              }}>
                {hostStats.lastBackupAt ? new Date(hostStats.lastBackupAt).toLocaleString() : ' - '}
              </div>
            </div>
          </div>
        ) : (
          <div className="muted" style={{ marginTop: 6 }}>Loading…</div>
        )}
      </div>

      <div className="panel">
        <strong>Player app release (self-update)</strong>
        <div className="muted" style={{ margin: '6px 0 12px' }}>
          Upload a signed release APK here, then trigger the install per screen from the
          <strong> Screens</strong> tab's "Install latest app update…" action - it's deliberately
          not automatic or bundled with Reload, since installing shows an on-screen Android
          confirm prompt that stops playback until someone at the TV taps it, only send it
          when a tech is on-site. Version code must be higher than what the TVs run (it is in
          player-android/app/build.gradle.kts, bump it each release). The TV verifies the
          file hash and the Android system verifies the signature before installing.
          For the install to succeed, that TV needs <strong>"Install unknown apps"</strong> allowed
          for the Galaxy Player app (Settings → Apps → Special app access → Install unknown apps).
        </div>
        {release ? (
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="muted">
              Current release: <strong style={{ color: 'var(--text)' }}>v{release.versionName}</strong>
              {' '}(code {release.versionCode}, {(release.sizeBytes / 1e6).toFixed(1)} MB,
              uploaded {new Date(release.uploadedAt).toLocaleString()})
            </span>
            {release.downloadUrl && (
              <a href={release.downloadUrl} download={`galaxy-player-v${release.versionName}.apk`}>
                <button className="secondary" type="button">Download APK</button>
              </a>
            )}
          </div>
        ) : (
          <div className="muted" style={{ marginBottom: 12 }}>
            No release uploaded yet - publish one below and a <strong>Download APK</strong> button
            will appear here for grabbing it onto new TVs.
          </div>
        )}
        <div className="muted" style={{ marginBottom: 12, fontSize: 13 }}>
          The download link is also how you get the APK onto brand-new TVs (USB stick or adb) -
          after that first install, push updates per screen from the Screens tab when a tech
          is on-site.
        </div>
        <div className="row">
          <input ref={fileInput} type="file" accept=".apk" style={{ display: 'none' }}
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? '')} />
          <button className="secondary" onClick={() => fileInput.current?.click()}>
            Choose APK…
          </button>
          {fileName && <span className="muted">{fileName}</span>}
          <input placeholder="Version code (e.g. 2)" value={versionCode} style={{ width: 150 }}
            onChange={(e) => setVersionCode(e.target.value.replace(/\D/g, ''))} />
          <input placeholder="Version name (e.g. 0.2.0)" value={versionName} style={{ width: 150 }}
            onChange={(e) => setVersionName(e.target.value)} />
          <button onClick={upload} disabled={!fileName || !versionCode || !versionName || progress !== null}>
            Publish release
          </button>
          {progress !== null && (
            <div className="row">
              <progress value={progress} max={100} style={{ width: 120 }} />
              <span className="muted">{progress}%</span>
            </div>
          )}
        </div>
      </div>

      {status && <div className="panel muted">{status}</div>}
      {error && <div className="error">{error}</div>}

      <div className="panel">
        <strong>Web player</strong>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          The browser-based player at <code>/player</code> lets any kiosk-mode browser
          (PC, Raspberry Pi) pair like a TV. Off by default; when disabled the page refuses
          to run and cannot request pairing codes. Existing web players stop at their next check.
        </div>
        <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={webPlayerEnabled ?? false}
            disabled={webPlayerEnabled === null}
            onChange={(e) => void toggleWebPlayer(e.target.checked)} />
          Enable the web player
        </label>
      </div>

      <div className="panel">
        <strong>Backups</strong>
        <div className="muted" style={{ marginTop: 6 }}>
          The server runs a nightly backup at 03:30 (database, media, config) to
          /var/backups/galaxy-media, keeping 7 days. Copy that directory offsite for real
          disaster recovery. Check status: <code>systemctl status galaxy-backup.timer</code>
        </div>
      </div>
    </>
  );
}
