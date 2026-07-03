import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, statfs, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { signDownload, verifyDownload } from '../lib/crypto.js';
import { isMspAdmin } from '../lib/permissions.js';
import { requireUser } from '../plugins/auth.js';

export interface ApkRelease {
  versionCode: number;
  versionName: string;
  sha256: string;
  sizeBytes: number;
  uploadedAt: string;
}

const APK_DIR = 'apk'; // under MEDIA_DIR so the static root covers it
const apkPath = () => path.join(config.MEDIA_DIR, APK_DIR, 'galaxy-player.apk');

export async function getApkRelease(): Promise<ApkRelease | null> {
  const { rows } = await query<{ value: ApkRelease }>(`SELECT value FROM settings WHERE key = 'apk_release'`);
  return rows[0]?.value ?? null;
}

interface SystemSettings {
  webPlayerEnabled: boolean;
}

async function getSystemSettings(): Promise<SystemSettings> {
  const { rows } = await query<{ value: Partial<SystemSettings> }>(
    `SELECT value FROM settings WHERE key = 'system'`,
  );
  return { webPlayerEnabled: false, ...(rows[0]?.value ?? {}) }; // web player is opt-in
}

export function systemRoutes(app: FastifyInstance): void {
  // Public: the /player page checks this before doing anything (default off).
  app.get('/api/player/config', async (_req, reply) => {
    const settings = await getSystemSettings();
    return reply.send({ enabled: settings.webPlayerEnabled });
  });
  // Device-facing: signed, token-checked APK download (query token, like media).
  app.get('/api/device/apk', async (req, reply) => {
    const { token } = z.object({ token: z.string() }).parse(req.query);
    if (!verifyDownload('apk', token)) return reply.code(401).send({ error: 'invalid_token' });
    try {
      await stat(apkPath());
    } catch {
      return reply.code(404).send({ error: 'no_release' });
    }
    return reply
      .header('content-type', 'application/vnd.android.package-archive')
      .sendFile(path.join(APK_DIR, 'galaxy-player.apk'));
  });

  app.register(async (scope) => {
    scope.addHook('preHandler', async (req, reply) => {
      await requireUser(req, reply);
      if (reply.sent) return;
      if (!isMspAdmin(req.principal!)) return reply.code(403).send({ error: 'forbidden' });
    });

    scope.get('/api/system/settings', async (_req, reply) => {
      return reply.send(await getSystemSettings());
    });

    // Host resource snapshot for the System tab (CPU/RAM/disk) - Linux only;
    // os.loadavg() reports zeros on other platforms.
    scope.get('/api/system/host-stats', async (_req, reply) => {
      let diskTotalBytes = 0;
      let diskFreeBytes = 0;
      let diskUsedBytes = 0;
      try {
        const disk = await statfs(config.MEDIA_DIR);
        diskTotalBytes = disk.blocks * disk.bsize;
        diskFreeBytes = disk.bavail * disk.bsize; // what non-root can still write
        // df-style used (blocks - bfree): total - bavail would wrongly count
        // the ~5% root-reserved blocks as "used" on an empty ext4 volume.
        diskUsedBytes = (disk.blocks - disk.bfree) * disk.bsize;
      } catch {
        // statfs unsupported on this platform/filesystem - UI shows "-"
      }
      // Written by deploy/backup.sh after each nightly run (the backup dir
      // itself is root-only, so this marker is how the API learns about it).
      let lastBackupAt: string | null = null;
      try {
        const marker = (await readFile(path.join(config.MEDIA_DIR, '.last-backup'), 'utf8')).trim();
        if (!Number.isNaN(Date.parse(marker))) lastBackupAt = marker;
      } catch {
        // No backup has run yet (or Docker install without the timer) - UI shows "-"
      }
      const [loadAvg1, loadAvg5, loadAvg15] = os.loadavg();
      return reply.send({
        cpuCores: os.cpus().length,
        loadAvg1, loadAvg5, loadAvg15,
        memTotalBytes: os.totalmem(),
        memFreeBytes: os.freemem(),
        diskTotalBytes,
        diskFreeBytes,
        diskUsedBytes,
        osUptimeS: os.uptime(),
        nodeVersion: process.version,
        lastBackupAt,
      });
    });

    scope.put('/api/system/settings', async (req, reply) => {
      const body = z.object({ webPlayerEnabled: z.boolean() }).parse(req.body);
      await query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('system', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [JSON.stringify(body)],
      );
      audit({
        userId: req.principal!.id,
        action: 'system.settings_update',
        ip: req.ip,
        detail: { webPlayerEnabled: body.webPlayerEnabled },
      });
      return reply.send({ ok: true });
    });

    scope.get('/api/system/apk', async (req, reply) => {
      const release = await getApkRelease();
      if (!release) return reply.send(null);
      // Signed link so admins/techs can download the APK for manual sideloads.
      const expires = Math.floor(Date.now() / 1000) + 6 * 3600;
      return reply.send({
        ...release,
        downloadUrl: `/api/device/apk?token=${signDownload('apk', req.principal!.id, expires)}`,
      });
    });

    // Upload a new player release. Version fields come as multipart fields
    // (parsing them out of the APK would need aapt on the server).
    scope.post('/api/system/apk', async (req, reply) => {
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: 'no_file' });
      const fields = z
        .object({
          versionCode: z.coerce.number().int().positive(),
          versionName: z.string().trim().min(1).max(50),
        })
        .parse(
          Object.fromEntries(
            Object.entries(part.fields).flatMap(([k, v]) =>
              v && 'value' in v && typeof v.value === 'string' ? [[k, v.value]] : [],
            ),
          ),
        );

      await mkdir(path.join(config.MEDIA_DIR, APK_DIR), { recursive: true });
      const tmp = `${apkPath()}.upload`;
      const hasher = createHash('sha256');
      let size = 0;
      let head = Buffer.alloc(0);
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hasher.update(chunk);
          size += chunk.length;
          if (head.length < 4) head = Buffer.concat([head, chunk]).subarray(0, 4);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(part.file, tap, createWriteStream(tmp, { flags: 'w', mode: 0o640 }));
        if (part.file.truncated) throw Object.assign(new Error('too_large'), { statusCode: 413 });
        // APKs are ZIP archives: enforce the magic bytes (PK\x03\x04).
        if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) {
          throw Object.assign(new Error('not_an_apk'), { statusCode: 415 });
        }
        await rename(tmp, apkPath());
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }

      const release: ApkRelease = {
        versionCode: fields.versionCode,
        versionName: fields.versionName,
        sha256: hasher.digest('hex'),
        sizeBytes: size,
        uploadedAt: new Date().toISOString(),
      };
      await query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('apk_release', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [JSON.stringify(release)],
      );
      audit({
        userId: req.principal!.id,
        action: 'system.apk_upload',
        ip: req.ip,
        detail: { versionCode: release.versionCode, versionName: release.versionName },
      });
      return reply.code(201).send(release);
    });
  });
}

/** Device update check payload; url is a signed download link. */
export async function apkInfoForDevice(screenId: string, expiresAtS: number): Promise<unknown> {
  const release = await getApkRelease();
  if (!release) return null;
  return {
    ...release,
    url: `${config.BASE_URL}/api/device/apk?token=${signDownload('apk', screenId, expiresAtS)}`,
  };
}
