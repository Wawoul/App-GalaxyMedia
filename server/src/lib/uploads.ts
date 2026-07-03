/** Magic-byte sniffing for uploads (SPEC §8: never trust extension/Content-Type). */

export interface SniffResult {
  kind: 'image' | 'video';
  mime: string;
  ext: string;
}

/** Single source of truth for the on-disk extension of every supported mime. */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
};

export function extFromMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? 'bin';
}

function result(kind: 'image' | 'video', mime: string): SniffResult {
  return { kind, mime, ext: EXT_BY_MIME[mime]! };
}

/** Valid BITMAPINFOHEADER sizes (offset 14, little-endian) across BMP versions. */
const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

/**
 * Reads the EBML DocType string ("webm" | "matroska") that follows the 4-byte
 * Matroska magic: element id 0x42 0x82, then a 1-byte 0x8N length, then ASCII.
 */
function ebmlDocType(head: Buffer): string | null {
  for (let i = 4; i < head.length - 2; i++) {
    if (head[i] === 0x42 && head[i + 1] === 0x82 && (head[i + 2]! & 0x80) !== 0) {
      const len = head[i + 2]! & 0x7f;
      if (i + 3 + len > head.length) return null;
      return head.subarray(i + 3, i + 3 + len).toString('latin1');
    }
  }
  return null;
}

/**
 * Sniffs the supported upload types from the first bytes of the file.
 * `head` should be at least 64 bytes for reliable Matroska/WebM detection
 * (the EBML DocType element sits shortly after the 4-byte magic).
 */
export function sniffMediaType(head: Buffer): SniffResult | null {
  if (head.length < 12) return null;
  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return result('image', 'image/jpeg');
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return result('image', 'image/png');
  }
  // GIF: "GIF87a" or "GIF89a"
  const gif = head.subarray(0, 6).toString('ascii');
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    return result('image', 'image/gif');
  }
  // BMP: "BM" alone is too weak - also require a known DIB header size at offset 14.
  if (head[0] === 0x42 && head[1] === 0x4d && head.length >= 18 && BMP_DIB_SIZES.has(head.readUInt32LE(14))) {
    return result('image', 'image/bmp');
  }
  // WebP: "RIFF" .... "WEBP"
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') {
    return result('image', 'image/webp');
  }
  // MP4/MOV family: "ftyp" at offset 4. QuickTime ("qt  ") keeps its own
  // mime/ext; every other brand is served as MP4, which players accept.
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') {
    if (head.subarray(8, 12).toString('ascii') === 'qt  ') {
      return result('video', 'video/quicktime');
    }
    return result('video', 'video/mp4');
  }
  // Matroska family: EBML magic 1A 45 DF A3, then the DocType element.
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    if (ebmlDocType(head) === 'webm') return result('video', 'video/webm');
    return result('video', 'video/x-matroska');
  }
  return null;
}
