import { describe, expect, it } from 'vitest';
import { isAllowedItemUrl } from './urls.js';

const OWN = ['signage.example.com'];

describe('isAllowedItemUrl', () => {
  it('accepts ordinary web pages, dashboards and streams', () => {
    for (const url of [
      'https://example.com/',
      'https://example.com/menu?table=4&token=abc',
      'http://192.168.1.50:3000/grafana/d/abc', // intranet dashboards are a real use
      'https://cdn.example.com/live/stream.m3u8',
      'HTTPS://Example.COM/Path',
    ]) {
      expect(isAllowedItemUrl(url, OWN), url).toBe(true);
    }
  });

  it('refuses every scheme that is not http or https', () => {
    // These render in the player. javascript:/data: run script in the player's own
    // context (the web player shares an origin with the admin app and its stored
    // tokens); file:/content: reach local files on the device.
    for (const url of [
      'javascript:alert(document.domain)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'content://com.android.providers.contacts/contacts',
      'intent://scan/#Intent;scheme=zxing;end',
      'ftp://example.com/file',
      'blob:https://example.com/1234',
      'vbscript:msgbox(1)',
    ]) {
      expect(isAllowedItemUrl(url, OWN), url).toBe(false);
    }
  });

  it('refuses things that are not absolute URLs', () => {
    for (const url of ['', ' ', 'example.com', '//example.com/x', '/relative/path', 'https://', 'http://:80']) {
      expect(isAllowedItemUrl(url, OWN), JSON.stringify(url)).toBe(false);
    }
  });

  it('refuses credentials embedded in the URL', () => {
    expect(isAllowedItemUrl('https://admin:hunter2@example.com/', OWN)).toBe(false);
    expect(isAllowedItemUrl('https://user@example.com/', OWN)).toBe(false);
  });

  it("refuses the server's own host, which would frame the admin app in the web player", () => {
    for (const url of [
      'https://signage.example.com/',
      'https://signage.example.com/api/health',
      'https://SIGNAGE.example.com:443/',
      'http://signage.example.com/',
    ]) {
      expect(isAllowedItemUrl(url, OWN), url).toBe(false);
    }
    // ...but not lookalikes.
    expect(isAllowedItemUrl('https://signage.example.com.evil.test/', OWN)).toBe(true);
    expect(isAllowedItemUrl('https://notsignage.example.com/', OWN)).toBe(true);
  });

  it('refuses anything over 2000 characters', () => {
    const prefix = 'https://example.com/'; // 20 chars
    expect(isAllowedItemUrl(prefix + 'a'.repeat(2000 - prefix.length), OWN)).toBe(true);
    expect(isAllowedItemUrl(prefix + 'a'.repeat(2001 - prefix.length), OWN)).toBe(false);
  });
});
