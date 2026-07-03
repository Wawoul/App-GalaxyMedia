import Hls from 'hls.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { nowInTimezone, resolveActive, type ScheduleEntry } from './schedule';

/**
 * Browser-based player: open /player on any device, pair with the code like a
 * TV. Best on a kiosk-mode browser (Chromium --kiosk on a Pi or PC).
 * Offline support is best-effort (browser HTTP cache) - the Android app remains
 * the choice for unattended screens that must survive outages.
 */

interface Item {
  id: string;
  type: string; // image | video | url
  name?: string | null;
  url?: string | null;
  durationMs?: number | null;
  muted?: boolean;
}
interface Playlist {
  id: string;
  items: Item[];
}
interface Zone {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  playlist?: Playlist | null;
  tickerTexts?: string[] | null;
}
interface Layout {
  id: string;
  zones: Zone[];
}
interface Entry extends ScheduleEntry {
  playlist?: Playlist | null;
  layout?: Layout | null;
}
interface Manifest {
  screen: { id: string; name: string; timezone: string; orientation?: number; brandName?: string };
  schedules: Entry[];
  playlist?: Playlist | null;
}

/**
 * Software rotation for sideways/upside-down mounted displays: the content is
 * rendered into a wrapper sized to the rotated viewport, so zone percentages
 * keep working. vw units would still track the physical viewport, so the
 * wrapper's font-size is set to 1% of the LOGICAL width and text inside uses
 * em multiples of it.
 */
function orientationStyle(deg: number): React.CSSProperties {
  const fontSize = deg === 90 || deg === 270 ? '1vh' : '1vw';
  switch (deg) {
    case 90:
      return {
        position: 'absolute', top: 0, left: 0, width: '100vh', height: '100vw', fontSize,
        transformOrigin: 'top left', transform: 'rotate(90deg) translateY(-100%)',
      };
    case 180:
      return { position: 'absolute', inset: 0, fontSize, transform: 'rotate(180deg)' };
    case 270:
      return {
        position: 'absolute', top: 0, left: 0, width: '100vh', height: '100vw', fontSize,
        transformOrigin: 'top left', transform: 'rotate(-90deg) translateX(-100%)',
      };
    default:
      return { position: 'absolute', inset: 0, fontSize };
  }
}

const TOKEN_KEY = 'gm_device_token';
const MANIFEST_KEY = 'gm_manifest';
const VERSION = 'web-1.1.0';

const isStream = (url: string) => {
  const path = url.split('?')[0]!.toLowerCase();
  return path.endsWith('.m3u8') || path.endsWith('.mpd');
};

async function deviceFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);
  return fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

// ── Item renderers ────────────────────────────────────────────────────────────

function StreamVideo({ item }: { item: Item }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video || !item.url) return;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = item.url; // Safari plays HLS natively
      return;
    }
    const hls = new Hls();
    hls.loadSource(item.url);
    hls.attachMedia(video);
    return () => hls.destroy();
  }, [item.url]);
  return <video ref={ref} autoPlay muted={item.muted ?? false} style={fill} />;
}

const fill: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'contain', border: 0 };

/** Cycles one playlist inside its zone. */
function PlaylistView({
  playlist,
  onItem,
}: {
  playlist: Playlist;
  onItem?: (name: string | null) => void;
}) {
  const [index, setIndex] = useState(0);
  const items = playlist.items;
  const item = items[index % items.length];

  useEffect(() => {
    setIndex(0);
  }, [playlist.id]);

  useEffect(() => {
    if (!item) return;
    onItem?.(item.name ?? item.url ?? null);
    // Videos without a fixed duration advance on their `ended` event instead.
    if (item.type === 'video' && item.durationMs == null) return;
    const ms =
      item.durationMs ??
      (item.type === 'image' ? 10_000 : item.url && isStream(item.url) ? 3_600_000 : 30_000);
    const timer = setTimeout(() => setIndex((i) => i + 1), ms);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, playlist.id]);

  if (!item?.url) return null;
  if (item.type === 'image') return <img src={item.url} style={fill} alt="" />;
  if (item.type === 'video') {
    return (
      <video key={`${item.id}-${index}`} src={item.url} autoPlay muted={item.muted ?? false}
        style={fill} onEnded={() => setIndex((i) => i + 1)} onError={() => setIndex((i) => i + 1)} />
    );
  }
  if (isStream(item.url)) return <StreamVideo key={`${item.id}-${index}`} item={item} />;
  return <iframe key={`${item.id}-${index}`} src={item.url} style={fill} title="content" />;
}

function Ticker({ texts }: { texts: string[] }) {
  return (
    <div style={{ width: '100%', height: '100%', background: '#000', overflow: 'hidden', display: 'flex', alignItems: 'center' }}>
      <div className="gm-ticker">{texts.join('      •      ')}</div>
    </div>
  );
}

// ── The player ────────────────────────────────────────────────────────────────

export function WebPlayer() {
  // Gated server-side: MSP admins enable the web player in the System tab (off by default).
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<'pairing' | 'playing'>(
    localStorage.getItem(TOKEN_KEY) ? 'playing' : 'pairing',
  );
  const [pairCode, setPairCode] = useState('……');
  const [manifest, setManifest] = useState<Manifest | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(MANIFEST_KEY) ?? 'null') as Manifest | null;
    } catch {
      return null;
    }
  });
  const [tick, setTick] = useState(0); // minute tick re-evaluates the schedule
  const [overlay, setOverlay] = useState('');
  const currentItem = useRef<string | null>(null);
  const plays = useRef<{ name: string; at: string }[]>([]);

  const onItem = useCallback((name: string | null) => {
    currentItem.current = name;
    if (name) {
      plays.current.push({ name, at: new Date().toISOString() });
      if (plays.current.length > 400) plays.current.splice(0, plays.current.length - 400);
    }
  }, []);

  const unpair = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(MANIFEST_KEY);
    setManifest(null);
    setPhase('pairing');
  }, []);

  const sync = useCallback(async () => {
    const res = await deviceFetch('/api/device/manifest');
    if (res.status === 401) return unpair();
    if (!res.ok) return;
    const next = (await res.json()) as Manifest;
    setManifest(next);
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(next));
  }, [unpair]);

  useEffect(() => {
    fetch('/api/player/config')
      .then((res) => res.json())
      .then((cfg: { enabled: boolean }) => setEnabled(cfg.enabled))
      .catch(() => setEnabled(false));
  }, []);

  // Pairing loop
  useEffect(() => {
    if (enabled !== true || phase !== 'pairing') return;
    let stop = false;
    (async () => {
      while (!stop) {
        try {
          const reg = (await (await fetch('/api/device/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })).json()) as { requestId: string; code: string; expiresInS: number; pollIntervalS: number };
          if (stop) return;
          setPairCode(reg.code);
          const deadline = Date.now() + reg.expiresInS * 1000;
          while (!stop && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, (reg.pollIntervalS || 5) * 1000));
            const poll = await fetch(`/api/device/register/${reg.requestId}`);
            if (poll.status === 410 || poll.status === 404) break;
            const data = (await poll.json()) as { status: string; deviceToken?: string };
            if (data.status === 'paired' && data.deviceToken) {
              localStorage.setItem(TOKEN_KEY, data.deviceToken);
              setPhase('playing');
              return;
            }
          }
        } catch {
          setPairCode('offline?');
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [enabled, phase]);

  // Sync + heartbeat + schedule tick + WebSocket
  useEffect(() => {
    if (enabled !== true || phase !== 'playing') return;
    void sync();
    const minute = setInterval(() => setTick((t) => t + 1), 60_000);
    const beat = setInterval(() => {
      // Honor the System-tab toggle: an already-running player stops when disabled.
      void fetch('/api/player/config')
        .then((res) => res.json())
        .then((cfg: { enabled: boolean }) => {
          if (!cfg.enabled) setEnabled(false);
        })
        .catch(() => {});
      const batch = plays.current.splice(0, plays.current.length);
      void deviceFetch('/api/device/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appVersion: VERSION,
          currentItem: currentItem.current ?? 'Idle - nothing assigned',
          plays: batch,
        }),
      }).then((res) => {
        if (res.status === 401) unpair();
      }).catch(() => plays.current.unshift(...batch)); // offline: keep for next beat
    }, 45_000);

    let ws: WebSocket | null = null;
    let closed = false;
    const connect = () => {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token || closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/device/ws?token=${token}`);
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as { type: string; command?: string };
        if (msg.type === 'sync' || msg.command === 'reload' || msg.command === 'clear_cache') void sync();
        else if (msg.type === 'unpair') unpair();
        else if (msg.command === 'identify') {
          setOverlay(manifestName());
          setTimeout(() => setOverlay(''), 5_000);
        } else if (msg.command === 'restart') location.reload();
      };
      ws.onclose = () => {
        if (!closed) setTimeout(connect, 15_000);
      };
    };
    const manifestName = () => {
      try {
        return (JSON.parse(localStorage.getItem(MANIFEST_KEY) ?? '{}') as Manifest).screen?.name ?? 'This screen';
      } catch {
        return 'This screen';
      }
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
      clearInterval(minute);
      clearInterval(beat);
    };
  }, [enabled, phase, sync, unpair]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (enabled === null) return <div className="gm-player" />; // checking

  if (!enabled) {
    return (
      <div className="gm-player gm-center">
        <div style={{ textAlign: 'center', fontSize: '2vw', opacity: 0.6, lineHeight: 1.6 }}>
          The web player is disabled on this server.
          <br />
          An MSP admin can enable it under System.
        </div>
      </div>
    );
  }

  if (phase === 'pairing') {
    return (
      <div className="gm-player gm-center">
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2.5vw', opacity: 0.7 }}>Pair this screen</div>
          <div style={{ fontSize: '10vw', fontWeight: 700, letterSpacing: '0.1em' }}>{pairCode}</div>
          <div style={{ fontSize: '1.8vw', opacity: 0.5 }}>{location.host}</div>
        </div>
      </div>
    );
  }

  void tick; // minute tick dependency for re-resolution below
  const entry = manifest?.schedules.length
    ? (resolveActive(manifest.schedules, nowInTimezone(manifest.screen.timezone)) as Entry | null)
    : null;
  const blackout = entry?.blackout === true;
  const layout = blackout ? null : entry?.layout;
  const playlist = blackout || layout ? null : manifest?.schedules.length ? entry?.playlist : manifest?.playlist;
  const brand = manifest?.screen.brandName?.trim() || 'Galaxy Media';

  return (
    <div className="gm-player">
      <div style={orientationStyle(manifest?.screen.orientation ?? 0)}>
      {blackout ? null : layout ? (
        layout.zones.map((zone) => (
          <div key={zone.key} style={{
            position: 'absolute',
            left: `${zone.x * 100}%`, top: `${zone.y * 100}%`,
            width: `${zone.w * 100}%`, height: `${zone.h * 100}%`,
          }}>
            {zone.tickerTexts?.length ? (
              <Ticker texts={zone.tickerTexts} />
            ) : zone.playlist?.items.length ? (
              <PlaylistView playlist={zone.playlist} onItem={zone.key === 'main' ? onItem : undefined} />
            ) : null}
          </div>
        ))
      ) : playlist?.items.length ? (
        <PlaylistView playlist={playlist} onItem={onItem} />
      ) : (
        <div className="gm-center" style={{ position: 'absolute', inset: 0 }}>
          <div style={{ textAlign: 'center', maxWidth: '70%', fontSize: '2.2em', lineHeight: 1.6 }}>
            {/* 2.7em of the 2.2em parent ≈ 6% of the logical width */}
            <div style={{ fontSize: '2.7em', fontWeight: 700, marginBottom: '0.4em' }}>:)</div>
            This screen is connected to {brand}
            {manifest?.screen.name && (
              <div style={{ fontWeight: 700, fontSize: '1.3em' }}>“{manifest.screen.name}”</div>
            )}
            <div style={{ opacity: 0.6, marginTop: '1em' }}>
              Assigned content will display here
            </div>
          </div>
        </div>
      )}
      {overlay && (
        <div className="gm-center" style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.75)', fontSize: '6em', fontWeight: 700 }}>
          {overlay}
        </div>
      )}
      </div>
    </div>
  );
}
