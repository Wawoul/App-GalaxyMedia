/** Minimal API client with token storage and automatic refresh. */

let accessToken: string | null = null;

export function getRefreshToken(): string | null {
  return localStorage.getItem('gm_refresh');
}

export function setSession(access: string, refresh: string): void {
  accessToken = access;
  localStorage.setItem('gm_refresh', refresh);
}

export function clearSession(): void {
  accessToken = null;
  localStorage.removeItem('gm_refresh');
}

async function tryRefresh(): Promise<boolean> {
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
  return (await res.json()) as T;
}

/** Restore a session from the stored refresh token on page load. */
export async function restoreSession(): Promise<boolean> {
  return tryRefresh();
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
