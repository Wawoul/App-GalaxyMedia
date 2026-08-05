import { existsSync } from 'node:fs';
import path from 'node:path';
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
    ['GalaxyPlayerV1.4.2.apk', 25, '1.4.2'],
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

  it('returns nulls for a file that is not an APK', () => {
    // A .idsig is a real file in that directory but not a zip we can read.
    const notApk = apk('GalaxyPlayerV1.4.2.apk.idsig');
    if (!existsSync(notApk)) return;
    expect(() => readApkVersion(notApk)).not.toThrow();
    expect(readApkVersion(notApk).versionCode).toBeNull();
  });
});
