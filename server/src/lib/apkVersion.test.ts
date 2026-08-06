import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readApkVersion } from './apkVersion.js';

/**
 * These read real signed APKs from player-android/app/release. The versionCode
 * they carry is what decides whether a screen offers an update at all - a wrong
 * value silently disables OTA updates fleet-wide, which is why it is read from
 * the file rather than typed at upload time.
 */
const releaseDir = path.join(process.cwd(), '..', 'player-android', 'app', 'release');
const apk = (name: string) => path.join(releaseDir, name);
const have = (name: string) => existsSync(apk(name));

describe('readApkVersion', () => {
  // Skips rather than fails if the local release folder is empty - a fresh
  // clone has no built APKs, and this should not break `npm test` there.
  const cases: [string, number, string][] = [
    ['GalaxyPlayerV1.4.8.apk', 30, '1.4.8'],
    ['GalaxyPlayerV1.1.1.apk', 3, '1.1.1'],
    ['GalaxyPlayerV1.1.0.apk', 2, '1.1.0'],
    ['GalaxyPlayerV1.0.0.apk', 1, '1.0.0'],
  ];
  for (const [name, versionCode, versionName] of cases) {
    const run = have(name) ? it : it.skip;
    run(`reads ${name} as ${versionName} (${versionCode})`, () => {
      expect(readApkVersion(apk(name))).toEqual({ versionCode, versionName });
    });
  }

  // This parses an uploaded file with raw offset arithmetic, in the single
  // process that serves every screen. A throw here would 500 the upload, so
  // every malformed shape must degrade to nulls instead.
  describe('malformed input', () => {
    const zipWith = (manifest: Buffer): Buffer => {
      const name = Buffer.from('AndroidManifest.xml');
      const data = deflateRawSync(manifest);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(manifest.length, 22);
      local.writeUInt16LE(name.length, 26);
      const localAll = Buffer.concat([local, name, data]);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(manifest.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(0, 42);
      const centralAll = Buffer.concat([central, name]);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(1, 8);
      eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(centralAll.length, 12);
      eocd.writeUInt32LE(localAll.length, 16);
      return Buffer.concat([localAll, centralAll, eocd]);
    };
    const chunk = (fill: (b: Buffer) => void, size: number) => {
      const b = Buffer.alloc(size);
      b.writeUInt16LE(0x0003, 0);
      b.writeUInt16LE(8, 2);
      b.writeUInt32LE(size, 4);
      fill(b);
      return b;
    };

    const shapes: [string, Buffer][] = [
      ['a manifest too short to hold a header', Buffer.from([0x03, 0x00])],
      [
        'a start-element chunk truncated at the buffer end',
        chunk((b) => {
          b.writeUInt16LE(0x0102, 8);
          b.writeUInt16LE(16, 10);
          b.writeUInt32LE(16, 12);
        }, 24),
      ],
      [
        'a resource map claiming billions of entries',
        chunk((b) => {
          b.writeUInt16LE(0x0180, 8);
          b.writeUInt16LE(8, 10);
          b.writeUInt32LE(0x7ffffff0, 12);
        }, 40),
      ],
      [
        'a chunk extending past the manifest',
        chunk((b) => {
          b.writeUInt16LE(0x0001, 8);
          b.writeUInt16LE(28, 10);
          b.writeUInt32LE(0xfffff, 12);
        }, 32),
      ],
      ['an empty file', Buffer.alloc(0)],
      ['random bytes', Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 37) % 256))],
    ];

    for (const [label, body] of shapes) {
      it(`returns nulls for ${label}`, () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'apk-test-'));
        const file = path.join(dir, 'x.apk');
        // The last two are not valid zips at all; the rest are zips wrapping a
        // hostile manifest.
        writeFileSync(file, body.length < 8 || label.startsWith('random') ? body : zipWith(body));
        expect(() => readApkVersion(file)).not.toThrow();
        expect(readApkVersion(file)).toEqual({ versionCode: null, versionName: null });
      });
    }
  });

  it('returns nulls for a file that is not an APK', () => {
    // A .idsig is a real file in that directory but not a zip we can read.
    const notApk = apk('GalaxyPlayerV1.4.8.apk.idsig');
    if (!existsSync(notApk)) return;
    expect(() => readApkVersion(notApk)).not.toThrow();
    expect(readApkVersion(notApk).versionCode).toBeNull();
  });
});
