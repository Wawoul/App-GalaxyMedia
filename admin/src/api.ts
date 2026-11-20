/** Minimal API client with token storage and automatic refresh. */

let accessToken: string | null = null;

export function getRefreshToken(): string | null {
  return localStorage.getItem('gm_refresh');
}

export function setSession(access: string, refresh: string): void {
  accessToken = access;
  localStorage.setItem('gm_refresh', refresh);
}

/**
 * Fired when the session is gone for good (refresh rejected/expired). App.tsx
 * listens and returns to the login screen; without it every page just rendered
 * its own "HTTP 401" banner and the only way out was a manual browser reload.
 */
export const SESSION_EXPIRED_EVENT = 'gm:session-expired';

export function clearSession(): void {
  const had = accessToken !== null || localStorage.getItem('gm_refresh') !== null;
  accessToken = null;
  localStorage.removeItem('gm_refresh');
  // Only announce a real transition, so logging out normally doesn't double-fire.
  if (had) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

// Pages fire parallel requests (Promise.all) that can all 401 at once when the
// access token expires. Without sharing one in-flight refresh, two calls would
// race on the same stored refresh token; if the server rotates it on use, the
// second call's response invalidates what the first just stored, wiping out a
// perfectly valid new session.
let refreshInFlight: Promise<boolean> | null = null;

async function rotateRefreshToken(): Promise<boolean> {
  // Read INSIDE the lock: another tab may have rotated the stored token while we
  // waited, and we must present the current one, not the one we saw earlier.
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    clearSession();
    return false;
  }
  const data = (await res.json()) as { accessToken: string; refreshToken: string };
  setSession(data.accessToken, data.refreshToken);
  return true;
}

// Every tab shares ONE stored refresh token. The in-flight sharing above only
// helps within a tab; restoring several tabs at once (a browser reopening its
// windows) made them all rotate the same token simultaneously. A browser-wide
// lock makes them take turns instead, each using the token the last one stored.
async function doRefresh(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('gm-refresh', rotateRefreshToken);
  }
  return rotateRefreshToken();
}

function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; formData?: FormData } = {},
): Promise<T> {
  const doFetch = () =>
    fetch(path, {
      method: options.method ?? (options.body || options.formData ? 'POST' : 'GET'),
      headers: {
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.formData ?? (options.body ? JSON.stringify(options.body) : undefined),
    });

  let res = await doFetch();
  if (res.status === 401 && (await tryRefresh())) res = await doFetch();
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  }
  // 204 and empty bodies are valid responses; res.json() would throw an opaque
  // SyntaxError that surfaces to the user as a meaningless error banner.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Restore a session from the stored refresh token on page load. */
export async function restoreSession(): Promise<boolean> {
  return tryRefresh();
}

/** At or below this, a file is sent as one request; above it, in pieces (matches the server's piece size). */
export const SINGLE_REQUEST_MAX_BYTES = 25 * 1024 * 1024;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Add a file to the library. Small files go up in one request. Big ones are sent as a series of
 * pieces (the size comes from the server), because whatever sits in front of the server - Cloudflare
 * on the free plan - refuses any single request over 100MB. A piece that fails is retried, and after
 * any doubt we ask the server how far it really got and carry on from there, so a flaky connection
 * costs a few seconds, not the whole upload.
 */
export async function uploadMedia(
  companyId: string,
  file: File,
  onProgress: (percent: number) => void,
  folderId: string | null = null,
): Promise<void> {
  if (file.size <= SINGLE_REQUEST_MAX_BYTES) {
    await uploadWithProgress(`/api/companies/${companyId}/media`, file, onProgress, folderId ? { folderId } : {});
    return;
  }
  const session = await api<{ uploadId: string; chunkSize: number }>(`/api/companies/${companyId}/media/uploads`, {
    body: { fileName: file.name, size: file.size, folderId },
  });
  try {
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + session.chunkSize, file.size);
      offset = await sendPiece(session.uploadId, file.slice(offset, end), offset, (sent) =>
        onProgress(Math.min(99, Math.round(((offset + sent) / file.size) * 100))));
      onProgress(Math.min(99, Math.round((offset / file.size) * 100)));
    }
    // Checking the finished file (type, checksum) can take a few seconds on a big one.
    await api(`/api/media/uploads/${session.uploadId}/complete`, { method: 'POST' });
    onProgress(100);
  } catch (err) {
    // Free the half-written file now rather than waiting for the server's idle clean-up.
    await api(`/api/media/uploads/${session.uploadId}`, { method: 'DELETE' }).catch(() => undefined);
    throw err;
  }
}

/** Sends one piece; resolves with how many bytes the server now holds (the offset of the next piece). */
async function sendPiece(uploadId: string, data: Blob, offset: number, onSent: (bytes: number) => void): Promise<number> {
  const end = offset + data.size;
  let lastError: unknown = new ApiError(0, 'network error');
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(8000, 1000 * 2 ** (attempt - 1)));
      // After a failure we cannot know whether the server kept the piece: ask, rather than guess.
      try {
        const where = await api<{ received: number }>(`/api/media/uploads/${uploadId}`);
        if (where.received === end) return end; // it did arrive; only the reply was lost
        if (where.received !== offset) return where.received; // out of step: let the caller re-slice from here
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) throw new ApiError(404, 'the upload was abandoned by the server - start it again');
        lastError = err;
        continue;
      }
    }
    const result = await putPiece(uploadId, data, offset, onSent);
    if (result.kind === 'ok') return result.received;
    if (result.kind === 'resync') return result.received; // the server is at a different offset than we thought
    if (result.kind === 'fatal') throw result.error;
    lastError = result.error;
  }
  throw lastError;
}

type PieceResult =
  | { kind: 'ok'; received: number }
  | { kind: 'resync'; received: number }
  | { kind: 'retry'; error: unknown }
  | { kind: 'fatal'; error: unknown };

async function putPiece(uploadId: string, data: Blob, offset: number, onSent: (bytes: number) => void): Promise<PieceResult> {
  const once = () =>
    new Promise<{ status: number; body: { received?: number; error?: string } }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/media/uploads/${uploadId}?offset=${offset}`);
      if (accessToken) xhr.setRequestHeader('authorization', `Bearer ${accessToken}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onSent(e.loaded); };
      xhr.onload = () => {
        let body: { received?: number; error?: string } = {};
        try { body = JSON.parse(xhr.responseText) as typeof body; } catch { /* non-JSON error page from a proxy */ }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () => reject(new ApiError(0, 'network error'));
      xhr.ontimeout = () => reject(new ApiError(0, 'timed out'));
      xhr.send(data);
    });
  try {
    let res = await once();
    if (res.status === 401 && (await tryRefresh())) res = await once();
    if (res.status === 200 && typeof res.body.received === 'number') return { kind: 'ok', received: res.body.received };
    if (res.status === 409 && typeof res.body.received === 'number') return { kind: 'resync', received: res.body.received };
    const error = new ApiError(res.status, res.body.error ?? `HTTP ${res.status}`);
    // 4xx other than the cases above (too large, no permission, quota...) will not get better by retrying.
    return res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 && res.body.error !== 'chunk_failed'
      ? { kind: 'fatal', error }
      : { kind: 'retry', error };
  } catch (error) {
    return { kind: 'retry', error };
  }
}

/**
 * Upload with progress callbacks (fetch can't report upload progress, so this
 * uses XHR). Keeps the page responsive during large video uploads.
 */
export async function uploadWithProgress(
  path: string,
  file: File,
  onProgress: (percent: number) => void,
  fields: Record<string, string> = {},
): Promise<void> {
  const attempt = () =>
    new Promise<number>((resolve, reject) => {
      const formData = new FormData();
      for (const [key, value] of Object.entries(fields)) formData.append(key, value);
      formData.append('file', file); // file last: fields must precede it in the multipart stream
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      if (accessToken) xhr.setRequestHeader('authorization', `Bearer ${accessToken}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.status);
        else if (xhr.status === 401) resolve(401); // caller refreshes and retries
        else {
          let message = `HTTP ${xhr.status}`;
          try {
            message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message;
          } catch {
            /* keep default */
          }
          reject(new ApiError(xhr.status, message));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, 'network error'));
      xhr.send(formData);
    });

  // Expired access token: refresh and retry once (same behavior as api()).
  if ((await attempt()) === 401) {
    if (!(await tryRefresh())) throw new ApiError(401, 'session expired - sign in again');
    if ((await attempt()) === 401) throw new ApiError(401, 'unauthenticated');
  }
}
