import { describe, expect, it } from 'vitest';
import { fetchRemoteFile, toDirectDownloadUrl } from './fetchUrl.js';

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
