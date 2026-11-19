import { describe, expect, it } from 'vitest';
import { fetchRemoteFile, suggestedNameFrom, toDirectDownloadUrl } from './fetchUrl.js';

/**
 * The import endpoint makes the server fetch a URL an admin supplies, which is
 * the classic SSRF shape: without these guards it becomes a proxy into the
 * server's own network. On a self-hosted product that LAN is precisely where
 * the interesting targets are, so these cases are the point of the feature's
 * security, not an afterthought.
 */
describe('fetchRemoteFile SSRF guards', () => {
  const opts = { maxBytes: 1024, timeoutMs: 2000 };

  it.each([
    ['http://127.0.0.1/x', 'loopback'],
    ['http://localhost/x', 'loopback by name'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata service'],
    ['http://10.0.0.5/x', 'RFC1918 10/8'],
    ['http://192.168.1.77/x', 'RFC1918 192.168/16'],
    ['http://172.16.0.9/x', 'RFC1918 172.16/12'],
    ['http://[::1]/x', 'IPv6 loopback'],
    ['http://0.0.0.0/x', 'unspecified'],
    ['http://100.64.0.1/x', 'CGNAT'],
  ])('rejects %s (%s)', async (url) => {
    await expect(fetchRemoteFile(url, opts)).rejects.toThrow();
  });

  // An IPv6 address can carry an IPv4 one in several notations, and matching
  // only the dotted spelling of ::ffff: left the hex form reaching loopback -
  // a complete bypass. Each notation below is a real address for a blocked
  // target, so these must all stay refused.
  it.each([
    ['http://[::ffff:7f00:1]/x', 'IPv4-mapped loopback, hex form'],
    ['http://[::ffff:c0a8:1]/x', 'IPv4-mapped 192.168.0.1, hex form'],
    ['http://[::ffff:127.0.0.1]/x', 'IPv4-mapped loopback, dotted form'],
    ['http://[::ffff:a9fe:a9fe]/x', 'IPv4-mapped cloud metadata'],
    ['http://[::127.0.0.1]/x', 'deprecated IPv4-compatible'],
    ['http://[64:ff9b::7f00:1]/x', 'NAT64-embedded loopback'],
    ['http://[2002:7f00:1::]/x', '6to4-embedded loopback'],
    ['http://[fd00::1]/x', 'unique-local'],
    ['http://[fe80::1]/x', 'link-local'],
  ])('rejects %s (%s)', async (url) => {
    await expect(fetchRemoteFile(url, opts)).rejects.toThrow(/not reachable/i);
  });

  it.each([
    ['http://198.18.0.1/x', 'benchmarking range'],
    ['http://192.0.2.5/x', 'TEST-NET-1'],
    ['http://198.51.100.5/x', 'TEST-NET-2'],
    ['http://203.0.113.5/x', 'TEST-NET-3'],
    ['http://192.0.0.8/x', 'IETF protocol assignments'],
  ])('rejects %s (%s)', async (url) => {
    await expect(fetchRemoteFile(url, opts)).rejects.toThrow(/not reachable/i);
  });

  // Alternate spellings of 127.0.0.1 - WHATWG URL normalises these, but assert
  // it rather than trusting it.
  it.each([
    ['http://0177.0.0.1/x', 'octal'],
    ['http://2130706433/x', 'decimal'],
    ['http://0x7f.0.0.1/x', 'hex octet'],
    ['http://127.1/x', 'short form'],
    ['http://user:pass@127.0.0.1/x', 'with credentials'],
  ])('rejects %s (%s)', async (url) => {
    await expect(fetchRemoteFile(url, opts)).rejects.toThrow(/not reachable/i);
  });

  it.each([
    ['file:///etc/passwd', 'file scheme'],
    ['ftp://example.com/x', 'ftp scheme'],
    ['gopher://example.com/x', 'gopher scheme'],
  ])('rejects %s (%s)', async (url) => {
    await expect(fetchRemoteFile(url, opts)).rejects.toThrow(/only http/i);
  });

  it('rejects a hostname that cannot resolve', async () => {
    await expect(
      fetchRemoteFile('http://no-such-host.invalid/x', opts),
    ).rejects.toThrow(/resolve/i);
  });
});

describe('suggestedNameFrom', () => {
  const url = (path: string) => new URL(`https://files.example.com${path}`);

  it("does not throw on a filename containing a bare '%'", () => {
    // decodeURIComponent throws on "50%_off", which made the whole import fail with
    // a 500 for a perfectly good file.
    expect(suggestedNameFrom(null, url('/menus/50%_off.mp4'))).toBe('50%_off.mp4');
    expect(suggestedNameFrom('attachment; filename="100%.mp4"', url('/x'))).toBe('100%.mp4');
  });

  it('decodes real percent-escapes', () => {
    expect(suggestedNameFrom(null, url('/caf%C3%A9.mp4'))).toBe('café.mp4');
    expect(suggestedNameFrom("attachment; filename*=UTF-8''caf%C3%A9.mp4", url('/x'))).toBe('café.mp4');
  });

  it('prefers the Content-Disposition name over the URL path', () => {
    expect(suggestedNameFrom('attachment; filename="menu.mp4"', url('/download?id=7'))).toBe('menu.mp4');
  });

  it('strips path separators a hostile name might carry', () => {
    expect(suggestedNameFrom('attachment; filename="../../etc/passwd"', url('/x'))).not.toMatch(/[/\\]/);
    expect(suggestedNameFrom(null, url('/a%2F..%2F..%2Fb.mp4'))).not.toMatch(/[/\\]/);
  });

  it('falls back to a default, and caps the length', () => {
    expect(suggestedNameFrom(null, url('/'))).toBe('import');
    expect(suggestedNameFrom(`attachment; filename="${'a'.repeat(400)}.mp4"`, url('/x'))).toHaveLength(300);
  });
});

describe('toDirectDownloadUrl', () => {
  it('turns a Dropbox preview link into a download', () => {
    expect(toDirectDownloadUrl('https://www.dropbox.com/s/abc/video.mp4?dl=0')).toContain('dl=1');
  });

  it('turns a Google Drive share link into a download', () => {
    const out = toDirectDownloadUrl('https://drive.google.com/file/d/FILEID123/view?usp=sharing');
    expect(out).toBe('https://drive.google.com/uc?export=download&id=FILEID123');
  });

  it('adds download=1 to a OneDrive/SharePoint link', () => {
    expect(toDirectDownloadUrl('https://contoso.sharepoint.com/:v:/g/abc')).toContain('download=1');
  });

  it('leaves an ordinary direct link alone', () => {
    const plain = 'https://cdn.example.com/media/clip.mp4';
    expect(toDirectDownloadUrl(plain)).toBe(plain);
  });

  it('rejects a malformed URL', () => {
    expect(() => toDirectDownloadUrl('not a url')).toThrow();
  });
});
