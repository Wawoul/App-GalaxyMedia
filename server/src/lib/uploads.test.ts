import { describe, expect, it } from 'vitest';
import { sniffMediaType } from './uploads.js';

/** Builds a 64-byte head starting with the given bytes (rest zero-padded). */
function head(...bytes: (number | string)[]): Buffer {
  const parts = bytes.map((b) => (typeof b === 'string' ? Buffer.from(b, 'latin1') : Buffer.from([b])));
  return Buffer.concat([...parts, Buffer.alloc(64)]).subarray(0, 64);
}

describe('sniffMediaType', () => {
  it('detects JPEG', () => {
    expect(sniffMediaType(head(0xff, 0xd8, 0xff, 0xe0))).toEqual({ kind: 'image', mime: 'image/jpeg', ext: 'jpg' });
  });

  it('detects PNG', () => {
    expect(sniffMediaType(head(0x89, 'PNG\r\n', 0x1a, '\n'))).toEqual({ kind: 'image', mime: 'image/png', ext: 'png' });
  });

  it('detects GIF (87a and 89a)', () => {
    expect(sniffMediaType(head('GIF87a'))).toEqual({ kind: 'image', mime: 'image/gif', ext: 'gif' });
    expect(sniffMediaType(head('GIF89a'))).toEqual({ kind: 'image', mime: 'image/gif', ext: 'gif' });
  });

  it('detects BMP (requires a valid DIB header size, not just "BM")', () => {
    // "BM" + 12 filler bytes, then DIB header size 40 (BITMAPINFOHEADER) at offset 14.
    const bmp = head('BM', ...Array(12).fill(0), 40, 0, 0, 0);
    expect(sniffMediaType(bmp)).toEqual({ kind: 'image', mime: 'image/bmp', ext: 'bmp' });
    expect(sniffMediaType(head('BMlol just some text file'))).toBeNull();
  });

  it('detects WebP', () => {
    expect(sniffMediaType(head('RIFF', 0, 0, 0, 0, 'WEBP'))).toEqual({ kind: 'image', mime: 'image/webp', ext: 'webp' });
  });

  it('detects MP4 (non-qt ftyp brands)', () => {
    expect(sniffMediaType(head(0, 0, 0, 0x20, 'ftypisom'))).toEqual({ kind: 'video', mime: 'video/mp4', ext: 'mp4' });
  });

  it('detects QuickTime MOV', () => {
    expect(sniffMediaType(head(0, 0, 0, 0x14, 'ftypqt  '))).toEqual({
      kind: 'video',
      mime: 'video/quicktime',
      ext: 'mov',
    });
  });

  it('detects WebM via EBML DocType', () => {
    expect(sniffMediaType(head(0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 'webm'))).toEqual({
      kind: 'video',
      mime: 'video/webm',
      ext: 'webm',
    });
  });

  it('detects MKV via EBML DocType', () => {
    expect(sniffMediaType(head(0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, 'matroska'))).toEqual({
      kind: 'video',
      mime: 'video/x-matroska',
      ext: 'mkv',
    });
  });

  it('does not mislabel an MKV whose header mentions "webm" outside the DocType', () => {
    // Muxing-app string contains "webm" but DocType says matroska.
    const mkv = head(0x1a, 0x45, 0xdf, 0xa3, 0x4d, 0x80, 0x84, 'webm', 0x42, 0x82, 0x88, 'matroska');
    expect(sniffMediaType(mkv)?.mime).toBe('video/x-matroska');
  });

  it('rejects unknown types and short heads', () => {
    expect(sniffMediaType(head('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00'))).toBeNull(); // PE .exe
    expect(sniffMediaType(head('<html><script>x</script>'))).toBeNull();
    expect(sniffMediaType(head('%PDF-1.7'))).toBeNull();
    expect(sniffMediaType(Buffer.from([0xff, 0xd8]))).toBeNull(); // too short
  });
});
