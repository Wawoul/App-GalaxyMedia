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
        const raw = Buffer.alloc(compressedSize);
        readSync(fd, raw, 0, compressedSize, dataStart);
        return method === 0 ? raw : inflateRawSync(raw);
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

  let pos = manifest.readUInt16LE(2); // skip the file header
  while (pos + 8 <= manifest.length) {
    const type = manifest.readUInt16LE(pos);
    const headerSize = manifest.readUInt16LE(pos + 2);
    const chunkSize = manifest.readUInt32LE(pos + 4);
    if (chunkSize <= 0) break;

    if (type === 0x0001) {
      poolStart = pos;
    } else if (type === 0x0180) {
      // Attribute ids, positionally matching the string pool.
      const count = Math.floor((chunkSize - headerSize) / 4);
      for (let n = 0; n < count; n++) {
        const id = manifest.readUInt32LE(pos + headerSize + n * 4);
        if (id === ATTR_VERSION_CODE) versionCodeIndex = n;
        if (id === ATTR_VERSION_NAME) versionNameIndex = n;
      }
    } else if (type === 0x0102) {
      // Start element: header, then 20 bytes of element fields, then the
      // attribute array. attributeStart is relative to the element fields.
      const attrStart = pos + headerSize + manifest.readUInt16LE(pos + headerSize + 8);
      const attrCount = manifest.readUInt16LE(pos + headerSize + 12);
      const attrSize = manifest.readUInt16LE(pos + headerSize + 10);
      for (let a = 0; a < attrCount; a++) {
        const entry = attrStart + a * (attrSize || 20);
        if (entry + 20 > manifest.length) break;
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
  const stringCount = manifest.readUInt32LE(poolStart + 8);
  if (index >= stringCount) return null;
  const flags = manifest.readUInt32LE(poolStart + 16);
  const stringsStart = poolStart + manifest.readUInt32LE(poolStart + 20);
  const offset = manifest.readUInt32LE(poolStart + 28 + index * 4);
  const at = stringsStart + offset;
  if (at + 2 > manifest.length) return null;
  const isUtf8 = (flags & (1 << 8)) !== 0;
  if (isUtf8) {
    // UTF-8 entries carry two length prefixes (chars then bytes).
    const length = manifest.readUInt8(at + 1);
    return manifest.toString('utf8', at + 2, at + 2 + length);
  }
  const length = manifest.readUInt16LE(at);
  return manifest.toString('utf16le', at + 2, at + 2 + length * 2);
}
