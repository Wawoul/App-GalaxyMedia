/** Magic-byte sniffing for uploads (SPEC §8: never trust extension/Content-Type). */

export interface SniffResult {
  kind: 'image' | 'video';
  mime: string;
  ext: string;
}

export function sniffMediaType(head: Buffer): SniffResult | null {
  if (head.length < 12) return null;
  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: 'image', mime: 'image/png', ext: 'png' };
  }
  // WebP: "RIFF" .... "WEBP"
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  }
  // MP4/MOV family: "ftyp" at offset 4
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') {
    return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  }
  return null;
}
