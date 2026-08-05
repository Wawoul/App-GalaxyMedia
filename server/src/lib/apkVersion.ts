import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/**
 * Reads versionCode/versionName straight out of an APK.
 *
 * These used to be typed in by hand at upload time, which is a quiet trap: the
 * player only offers an update when the server's versionCode is *higher* than
 * its own, so one mistyped digit silently disables OTA updates for the whole
 * fleet with no error anywhere. The number is already in the file, so read it.
 *
 * An APK is a ZIP holding AndroidManifest.xml in Android's binary XML format.
 * Rather than decode that format properly (a lot of code for two integers), we
 * scan the resource-map/attribute area for the well-known attribute ids -
 * enough to be reliable, and a wrong answer only costs us the cross-check.
 */
export interface ApkVersion {
  versionCode: number | null;
  versionName: string | null;
}

// Bounds for values read out of the file itself. A real APK's central
// directory is tens of KB and its manifest well under a megabyte; anything
// larger is corrupt or hostile, and allocating it would be an easy way to
// exhaust memory in the single process that serves every screen.
const MAX_CENTRAL_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Extracts one file from a ZIP by name, without pulling in a zip library. */
function readZipEntry(file: string, wanted: string): Buffer | null {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    // End-of-central-directory lives in the last 64KB (comment field is capped).
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const entries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    // These come straight from the file, so a hostile or corrupt APK can claim
    // a 4GB directory. Allocating that on a small server would be a trivial way
    // to OOM a process that serves every screen.
    if (centralSize > MAX_CENTRAL_BYTES || centralOffset + centralSize > size) return null;

    const central = Buffer.alloc(centralSize);
    readSync(fd, central, 0, centralSize, centralOffset);

    let pos = 0;
    for (let i = 0; i < entries && pos + 46 <= central.length; i++) {
      if (central.readUInt32LE(pos) !== CENTRAL_SIGNATURE) break;
      const method = central.readUInt16LE(pos + 10);
      const compressedSize = central.readUInt32LE(pos + 20);
      const nameLength = central.readUInt16LE(pos + 28);
      const extraLength = central.readUInt16LE(pos + 30);
      const commentLength = central.readUInt16LE(pos + 32);
      const localOffset = central.readUInt32LE(pos + 42);
      const name = central.toString('utf8', pos + 46, pos + 46 + nameLength);

      if (name === wanted) {
        // Local header repeats the name/extra lengths, which may differ.
        const local = Buffer.alloc(30);
        readSync(fd, local, 0, 30, localOffset);
        const localName = local.readUInt16LE(26);
        const localExtra = local.readUInt16LE(28);
        const dataStart = localOffset + 30 + localName + localExtra;
        if (compressedSize > MAX_MANIFEST_BYTES || dataStart + compressedSize > size) return null;
        const raw = Buffer.alloc(compressedSize);
        readSync(fd, raw, 0, compressedSize, dataStart);
        // maxOutputLength caps the decompressed size too - a zip bomb otherwise
        // inflates a few KB into gigabytes.
        return method === 0
          ? raw
          : inflateRawSync(raw, { maxOutputLength: MAX_MANIFEST_BYTES });
      }
      pos += 46 + nameLength + extraLength + commentLength;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

// Android framework attribute resource ids - stable across every SDK level.
const ATTR_VERSION_CODE = 0x0101021b;
const ATTR_VERSION_NAME = 0x0101021c;

/**
 * Pulls the two values out of the binary manifest. Attribute entries are 20-byte
 * records ending in a typed value; we find the attribute-id table, then read the
 * entry whose name index matches.
 */
export function readApkVersion(file: string): ApkVersion {
  // The bounds checks below should make this total, but this parses an
  // uploaded file with raw offset arithmetic; a miss would 500 the upload and,
  // worse, leave a corrupt APK installed for every screen to be offered.
  try {
    return parseApkVersion(file);
  } catch {
    return { versionCode: null, versionName: null };
  }
}

function parseApkVersion(file: string): ApkVersion {
  const manifest = readZipEntry(file, 'AndroidManifest.xml');
  if (!manifest) return { versionCode: null, versionName: null };

  // Walk the top-level chunks: string pool (0x0001), resource map (0x0180),
  // then the element tree. Offsets come from each chunk's own header rather
  // than being assumed, which is what makes this survive aapt version changes.
  let poolStart = -1;
  let versionCodeIndex = -1;
  let versionNameIndex = -1;
  let versionCode: number | null = null;
  let versionNameRef: number | null = null;

  if (manifest.length < 8) return { versionCode: null, versionName: null };
  let pos = manifest.readUInt16LE(2); // skip the file header
  while (pos >= 0 && pos + 8 <= manifest.length) {
    const type = manifest.readUInt16LE(pos);
    const headerSize = manifest.readUInt16LE(pos + 2);
    const chunkSize = manifest.readUInt32LE(pos + 4);
    // Every one of these came from the file: a chunk claiming to extend past
    // the buffer, or a header larger than its own chunk, is corrupt. Stop
    // rather than read out of range - this parses an uploaded file, so a throw
    // here would 500 the API for every screen.
    if (chunkSize <= 0 || headerSize < 8 || headerSize > chunkSize) break;
    if (pos + chunkSize > manifest.length) break;

    if (type === 0x0001) {
      poolStart = pos;
    } else if (type === 0x0180) {
      // Attribute ids, positionally matching the string pool.
      const count = Math.floor((chunkSize - headerSize) / 4);
      for (let n = 0; n < count; n++) {
        const at = pos + headerSize + n * 4;
        if (at + 4 > manifest.length) break;
        const id = manifest.readUInt32LE(at);
        if (id === ATTR_VERSION_CODE) versionCodeIndex = n;
        if (id === ATTR_VERSION_NAME) versionNameIndex = n;
      }
    } else if (type === 0x0102 && pos + headerSize + 14 <= manifest.length) {
      // Start element: header, then 20 bytes of element fields, then the
      // attribute array. attributeStart is relative to the element fields.
      const attrStart = pos + headerSize + manifest.readUInt16LE(pos + headerSize + 8);
      const attrCount = manifest.readUInt16LE(pos + headerSize + 12);
      const attrSize = manifest.readUInt16LE(pos + headerSize + 10);
      for (let a = 0; a < attrCount; a++) {
        const entry = attrStart + a * (attrSize || 20);
        if (entry < 0 || entry + 20 > manifest.length) break;
        const nameIndex = manifest.readUInt32LE(entry + 4);
        const dataType = manifest.readUInt8(entry + 15);
        const data = manifest.readUInt32LE(entry + 16);
        // 0x10 = TYPE_INT_DEC, 0x03 = TYPE_STRING (index into the pool).
        if (nameIndex === versionCodeIndex && dataType === 0x10) versionCode = data;
        if (nameIndex === versionNameIndex && dataType === 0x03) versionNameRef = data;
      }
    }
    pos += chunkSize;
  }

  return {
    versionCode,
    versionName:
      versionNameRef !== null && poolStart >= 0 ? readPoolString(manifest, poolStart, versionNameRef) : null,
  };
}

/** Reads one entry from the manifest's string pool chunk. */
function readPoolString(manifest: Buffer, poolStart: number, index: number): string | null {
  if (poolStart + 28 + (index + 1) * 4 > manifest.length) return null;
  const stringCount = manifest.readUInt32LE(poolStart + 8);
  if (index >= stringCount) return null;
  const flags = manifest.readUInt32LE(poolStart + 16);
  const stringsStart = poolStart + manifest.readUInt32LE(poolStart + 20);
  const offset = manifest.readUInt32LE(poolStart + 28 + index * 4);
  const at = stringsStart + offset;
  if (at < 0 || at + 2 > manifest.length) return null;
  const isUtf8 = (flags & (1 << 8)) !== 0;
  if (isUtf8) {
    // UTF-8 entries carry two length prefixes (chars then bytes).
    const length = manifest.readUInt8(at + 1);
    return manifest.toString('utf8', at + 2, Math.min(at + 2 + length, manifest.length));
  }
  const length = manifest.readUInt16LE(at);
  return manifest.toString('utf16le', at + 2, Math.min(at + 2 + length * 2, manifest.length));
}
