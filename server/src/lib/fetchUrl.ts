import dns from 'node:dns';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

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

/**
 * Expands an IPv6 address to its eight 16-bit groups, so embedded IPv4 can be
 * recovered whatever notation was used. `::ffff:7f00:1` and `::ffff:127.0.0.1`
 * are the same address; matching only the dotted spelling let the hex form
 * straight through to loopback.
 */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0]!; // drop any zone index
  // A trailing dotted quad (::ffff:127.0.0.1) becomes two hex groups.
  const dotted = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const octets = dotted[1]!.split('.').map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hex = `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
    text = text.slice(0, dotted.index) + hex;
  }
  const [head, tail] = text.split('::') as [string, string | undefined];
  const parse = (part: string) => (part ? part.split(':').filter(Boolean).map((g) => parseInt(g, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  if (tail === undefined) return left.length === 8 ? left : null;
  const groups = [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

/** Blocked IPv4 ranges: loopback, link-local (incl. cloud metadata), private, reserved. */
function isBlockedV4(p: [number, number, number, number]): boolean {
  return (
    p[0] === 0 || // "this host"
    p[0] === 10 || // RFC1918
    p[0] === 127 || // loopback
    (p[0] === 169 && p[1] === 254) || // link-local: AWS/GCP/Azure metadata is 169.254.169.254
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || // RFC1918
    (p[0] === 192 && p[1] === 168) || // RFC1918
    (p[0] === 192 && p[1] === 0 && p[2] === 0) || // IETF protocol assignments
    (p[0] === 192 && p[1] === 0 && p[2] === 2) || // TEST-NET-1
    (p[0] === 198 && (p[1] === 18 || p[1] === 19)) || // benchmarking
    (p[0] === 198 && p[1] === 51 && p[2] === 100) || // TEST-NET-2
    (p[0] === 203 && p[1] === 0 && p[2] === 113) || // TEST-NET-3
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || // CGNAT
    p[0] >= 224 // multicast + reserved
  );
}

/** Blocked ranges: loopback, link-local (incl. cloud metadata), and private space. */
function isBlockedIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) {
    return isBlockedV4(ip.split('.').map(Number) as [number, number, number, number]);
  }
  if (type === 6) {
    const g = v6Groups(ip);
    if (!g) return true; // unparseable - refuse rather than guess
    const [a, b, c, d, e, f, gg, h] = g as [number, number, number, number, number, number, number, number];
    if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0) {
      // ::, ::1, ::ffff:x.x.x.x (mapped) and ::x.x.x.x (deprecated compatible)
      if (f === 0 && gg === 0 && h <= 1) return true; // :: and ::1
      if (f === 0xffff || f === 0) {
        return isBlockedV4([gg >> 8, gg & 0xff, h >> 8, h & 0xff]);
      }
    }
    // 64:ff9b::/96 NAT64 - carries an IPv4 destination in the low groups.
    if (a === 0x64 && b === 0xff9b) return isBlockedV4([gg >> 8, gg & 0xff, h >> 8, h & 0xff]);
    // 2002::/16 6to4 - the IPv4 address sits in the next two groups.
    if (a === 0x2002) return isBlockedV4([b >> 8, b & 0xff, c >> 8, c & 0xff]);
    if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
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
  // URL.hostname keeps the brackets on an IPv6 literal, which net.isIP rejects.
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  // A bare IP in the URL skips DNS entirely.
  if (net.isIP(bare)) {
    if (isBlockedIp(bare)) throw badUrl('that address is not reachable from here');
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

type ResolvedAddress = { address: string; family: number };
type Resolver = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses?: ResolvedAddress[]) => void,
) => void;

/**
 * A DNS lookup that refuses private answers, for use at CONNECTION time.
 *
 * assertPublicHost() resolves the hostname up front, but the HTTP client then
 * resolves it AGAIN when it connects. A hostile DNS server can answer the first
 * with a public address and the second with 127.0.0.1 (DNS rebinding), walking
 * straight past a check that only ran once. Plugging this into the connection
 * itself validates the very answer that is about to be connected to - including
 * on every redirect hop, since each opens its own connection. (IP literals skip
 * DNS entirely; assertPublicHost covers those.)
 */
export function guardedLookup(resolve: Resolver = dns.lookup as unknown as Resolver) {
  return (
    hostname: string,
    options: { all?: boolean; [key: string]: unknown },
    callback: (err: Error | null, address?: string | ResolvedAddress[], family?: number) => void,
  ): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses ?? [];
      if (list.length === 0) return callback(badUrl('could not resolve that hostname'));
      // Every address, not just the first: a name that resolves to both a public
      // and a private address must not get to pick the private one.
      if (list.some((a) => isBlockedIp(a.address))) return callback(badUrl('that address is not reachable from here'));
      if (options.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export const guardedAgent = new Agent({ connect: { lookup: guardedLookup() as never } });

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

    const response = await undiciFetch(url, {
      redirect: 'manual', // hop-by-hop, so each destination is re-validated
      signal: AbortSignal.timeout(timeout),
      headers: { accept: '*/*' },
      dispatcher: guardedAgent, // re-checks the address at connect time (DNS rebinding)
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

export function suggestedNameFrom(disposition: string | null, url: URL): string {
  const fromHeader = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
  const candidate = fromHeader ?? url.pathname.split('/').filter(Boolean).pop() ?? 'import';
  // decodeURIComponent throws on a bare '%' ("50%_off.mp4"), which used to turn a
  // perfectly good download into a 500. A name that does not decode is used as-is.
  let decoded = candidate;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    /* not percent-encoded after all */
  }
  // Strip any path components a hostile filename might carry.
  const safe = decoded.replace(/[/\\]/g, '').trim();
  return safe.slice(0, 300) || 'import';
}
