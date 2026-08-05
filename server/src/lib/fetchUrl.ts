import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * Guarded fetching for admin-supplied URLs (media import).
 *
 * A server that downloads arbitrary URLs on request is a textbook SSRF pivot:
 * without checks, an admin - or anyone who compromises an admin account - can
 * make the server read its own metadata service, reach other boxes on the LAN
 * it happens to sit on, or probe internal ports through the response/error it
 * gets back. On a self-hosted product the LAN is exactly where the interesting
 * targets are, so this matters more here than it would on a cloud tenant.
 *
 * The rules below are deliberately strict; media lives on public file shares,
 * so nothing legitimate needs a private address.
 */

/** Blocked ranges: loopback, link-local (incl. cloud metadata), and RFC1918. */
function isBlockedIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) {
    const p = ip.split('.').map(Number) as [number, number, number, number];
    return (
      p[0] === 0 || // "this host"
      p[0] === 10 || // RFC1918
      p[0] === 127 || // loopback
      (p[0] === 169 && p[1] === 254) || // link-local: AWS/GCP/Azure metadata lives at 169.254.169.254
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || // RFC1918
      (p[0] === 192 && p[1] === 168) || // RFC1918
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || // CGNAT
      p[0] >= 224 // multicast + reserved
    );
  }
  if (type === 6) {
    const v6 = ip.toLowerCase();
    // ::1 loopback, fc00::/7 unique-local, fe80::/10 link-local, :: unspecified.
    if (v6 === '::1' || v6 === '::') return true;
    if (/^f[cd]/.test(v6)) return true;
    if (/^fe[89ab]/.test(v6)) return true;
    // IPv4-mapped (::ffff:10.0.0.1) - re-check the embedded address.
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]!);
    return false;
  }
  return true; // not an IP at all
}

/**
 * Resolves the host and rejects private targets. Checking every returned
 * address (not just the first) closes the case where a hostname resolves to
 * both a public and a private address.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  // A bare IP in the URL skips DNS entirely.
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw badUrl('that address is not reachable from here');
    return;
  }
  const results = await lookup(hostname, { all: true }).catch(() => {
    throw badUrl('could not resolve that hostname');
  });
  if (results.length === 0) throw badUrl('could not resolve that hostname');
  for (const { address } of results) {
    if (isBlockedIp(address)) throw badUrl('that address is not reachable from here');
  }
}

function badUrl(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * Some services hand out a "preview" page rather than the file. Rewriting the
 * common ones means an admin can paste the link they actually have, instead of
 * hunting for a direct-download variant.
 */
export function toDirectDownloadUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badUrl('that does not look like a valid URL');
  }
  const host = url.hostname.toLowerCase();

  // Dropbox: ?dl=0 renders a preview page; dl=1 serves the file.
  if (host.endsWith('dropbox.com')) {
    url.searchParams.set('dl', '1');
    return url.toString();
  }
  // Google Drive: /file/d/<id>/view -> the direct download endpoint.
  if (host === 'drive.google.com') {
    const id = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ?? url.searchParams.get('id');
    if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  // OneDrive/SharePoint share links accept a download=1 parameter.
  if (host.endsWith('sharepoint.com') || host === '1drv.ms') {
    url.searchParams.set('download', '1');
    return url.toString();
  }
  return url.toString();
}

export interface FetchedStream {
  body: NodeJS.ReadableStream;
  /** Content-Length when the server sent one; null when it didn't. */
  declaredBytes: number | null;
  /** Filename from Content-Disposition or the URL path, best effort. */
  suggestedName: string;
}

/**
 * Opens a guarded GET. Follows redirects manually so every hop is re-checked -
 * following them automatically would let a public URL bounce to 127.0.0.1 and
 * defeat the whole check.
 */
export async function fetchRemoteFile(
  rawUrl: string,
  opts: { maxBytes: number; timeoutMs?: number },
): Promise<FetchedStream> {
  let current = toDirectDownloadUrl(rawUrl);
  const timeout = opts.timeoutMs ?? 30 * 60_000; // generous: 300MB on a slow link

  for (let hop = 0; hop < 5; hop++) {
    const url = new URL(current);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      // file:, ftp:, gopher: etc. are all read-primitives in disguise.
      throw badUrl('only http:// and https:// links are supported');
    }
    await assertPublicHost(url.hostname);

    const response = await fetch(url, {
      redirect: 'manual', // hop-by-hop, so each destination is re-validated
      signal: AbortSignal.timeout(timeout),
      headers: { accept: '*/*' },
    }).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : 'request failed';
      throw badUrl(`could not fetch that link (${reason})`);
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw badUrl('the link redirected without a destination');
      await response.body?.cancel();
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      throw badUrl(`the link returned HTTP ${response.status}`);
    }
    if (!response.body) throw badUrl('the link returned no content');

    // Reject on the declared size before streaming a single byte where we can;
    // the caller still enforces the cap as it writes, for servers that lie or
    // omit Content-Length.
    const lengthHeader = response.headers.get('content-length');
    const declaredBytes = lengthHeader ? Number(lengthHeader) : null;
    if (declaredBytes !== null && Number.isFinite(declaredBytes) && declaredBytes > opts.maxBytes) {
      await response.body.cancel();
      throw Object.assign(
        new Error(`that file is ${Math.round(declaredBytes / 1024 / 1024)}MB, over the limit`),
        { statusCode: 413 },
      );
    }

    return {
      body: response.body as unknown as NodeJS.ReadableStream,
      declaredBytes: Number.isFinite(declaredBytes) ? declaredBytes : null,
      suggestedName: suggestedNameFrom(response.headers.get('content-disposition'), url),
    };
  }
  throw badUrl('that link redirected too many times');
}

function suggestedNameFrom(disposition: string | null, url: URL): string {
  const fromHeader = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
  const candidate = fromHeader ?? url.pathname.split('/').filter(Boolean).pop() ?? 'import';
  // Strip any path components a hostile filename might carry.
  const safe = decodeURIComponent(candidate).replace(/[/\\]/g, '').trim();
  return safe.slice(0, 300) || 'import';
}
