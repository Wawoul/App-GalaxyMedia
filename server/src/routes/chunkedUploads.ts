import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, truncate, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { canAccessCompany } from '../lib/permissions.js';
import { checkRoom } from '../lib/quota.js';
import { requireUser } from '../plugins/auth.js';
import { notifyCompany } from '../ws.js';
import { finalizeStoredMedia, roomError } from './media.js';

/**
 * Large files, in pieces. A single upload request is capped by whatever sits in front of the
 * server - Cloudflare's free plan refuses any request over 100MB - so the browser sends a big file
 * as a series of small ones (UPLOAD_CHUNK_MB each) to one growing scratch file, then asks the
 * server to finish it. Each piece names the byte offset it starts at, so a piece that fails can be
 * sent again without corrupting the file, and the browser can always ask how far the server got.
 *
 * Sessions live in memory with their scratch file (`.upload-*`, which the startup sweep already
 * clears): a server restart abandons the upload and the browser simply starts it again.
 */
interface Session {
  id: string;
  companyId: string;
  userId: string;
  fileName: string;
  size: number;
  received: number;
  folderId: string | null;
  tmpFile: string;
  mediaId: string;
  busy: boolean;
  lastAt: number;
}

const MB = 1024 * 1024;
const MAX_SESSIONS_PER_COMPANY = 4;
const IDLE_MS = 60 * 60_000;
const sessions = new Map<string, Session>();

async function discard(s: Session): Promise<void> {
  sessions.delete(s.id);
  await unlink(s.tmpFile).catch(() => {});
}

// An abandoned upload (tab closed mid-way) must not hold disk for ever.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) if (!s.busy && now - s.lastAt > IDLE_MS) void discard(s);
}, 5 * 60_000).unref();

/** Test hook: how many uploads are in progress. */
export const activeChunkedUploads = () => sessions.size;

export function chunkedUploadRoutes(app: FastifyInstance): void {
  const chunkSize = config.UPLOAD_CHUNK_MB * MB;

  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser);

    // The session is only ever visible to whoever started it (and only while they may still edit).
    const mine = (req: { principal?: { id: string } }, id: string): Session | null => {
      const s = sessions.get(id);
      return s && req.principal && s.userId === req.principal.id ? s : null;
    };

    scope.post('/api/companies/:companyId/media/uploads', async (req, reply) => {
      const { companyId } = z.object({ companyId: z.string().uuid() }).parse(req.params);
      if (!canAccessCompany(req.principal!, companyId, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const body = z
        .object({
          fileName: z.string().trim().min(1).max(300),
          size: z.number().int().positive(),
          folderId: z.string().uuid().nullish(),
        })
        .parse(req.body);
      if (body.size > config.MAX_UPLOAD_MB * MB) return reply.code(413).send({ error: 'too_large' });
      // Refuse before a byte is sent, exactly as the single-request upload does.
      const room = await checkRoom(companyId, body.size);
      if (room !== 'ok') {
        const { status, error } = roomError(room);
        return reply.code(status).send({ error });
      }
      if (body.folderId) {
        const { rowCount } = await query('SELECT 1 FROM media_folders WHERE id = $1 AND company_id = $2', [body.folderId, companyId]);
        if (!rowCount) return reply.code(400).send({ error: 'folder_not_found' });
      }
      if ([...sessions.values()].filter((s) => s.companyId === companyId).length >= MAX_SESSIONS_PER_COMPANY) {
        return reply.code(429).send({ error: 'too_many_uploads' });
      }

      const id = randomUUID();
      const mediaId = randomUUID();
      const dir = path.join(config.MEDIA_DIR, companyId);
      await mkdir(dir, { recursive: true });
      const tmpFile = path.join(dir, `.upload-chunked-${id}`);
      await (await open(tmpFile, 'wx', 0o640)).close();
      sessions.set(id, {
        id, companyId, userId: req.principal!.id, fileName: path.basename(body.fileName), size: body.size,
        received: 0, folderId: body.folderId ?? null, tmpFile, mediaId, busy: false, lastAt: Date.now(),
      });
      return reply.code(201).send({ uploadId: id, chunkSize, size: body.size });
    });

    scope.get('/api/media/uploads/:id', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const s = mine(req, id);
      if (!s) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ received: s.received, size: s.size });
    });

    /** One piece: the raw bytes as the body, `?offset=` the position it starts at. */
    scope.put('/api/media/uploads/:id', { bodyLimit: chunkSize + MB }, async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { offset } = z.object({ offset: z.coerce.number().int().min(0) }).parse(req.query);
      const s = mine(req, id);
      if (!s) return reply.code(404).send({ error: 'not_found' });
      if (!canAccessCompany(req.principal!, s.companyId, 'editor')) return reply.code(403).send({ error: 'forbidden' });
      if (s.busy) return reply.code(409).send({ error: 'busy', received: s.received });
      // The client resyncs from `received` after any doubt, so a stale offset is a normal, recoverable answer.
      if (offset !== s.received) return reply.code(409).send({ error: 'offset_mismatch', received: s.received });

      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && (declared > chunkSize + 1024 || s.received + declared > s.size)) {
        return reply.code(413).send({ error: 'chunk_too_large' });
      }

      s.busy = true;
      let n = 0;
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          n += chunk.length;
          // Counted as it arrives: Content-Length can be absent or wrong.
          if (n > chunkSize + 1024 || s.received + n > s.size) {
            cb(Object.assign(new Error('chunk_too_large'), { statusCode: 413 }));
            return;
          }
          cb(null, chunk);
        },
      });
      try {
        await pipeline(req.body as NodeJS.ReadableStream, tap, createWriteStream(s.tmpFile, { flags: 'a' }));
        s.received += n;
        s.lastAt = Date.now();
        return reply.send({ received: s.received });
      } catch (err) {
        // A dropped connection leaves a partial piece on disk; cut it back so the file only ever
        // holds whole, acknowledged pieces and the same offset can simply be sent again.
        await truncate(s.tmpFile, s.received).catch(() => {});
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 413) return reply.code(413).send({ error: 'chunk_too_large' });
        return reply.code(400).send({ error: 'chunk_failed', received: s.received });
      } finally {
        s.busy = false;
      }
    });

    scope.post('/api/media/uploads/:id/complete', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const s = mine(req, id);
      if (!s) return reply.code(404).send({ error: 'not_found' });
      if (!canAccessCompany(req.principal!, s.companyId, 'editor')) return reply.code(403).send({ error: 'forbidden' });
      if (s.busy) return reply.code(409).send({ error: 'busy', received: s.received });
      if (s.received !== s.size) return reply.code(400).send({ error: 'incomplete', received: s.received, size: s.size });

      s.busy = true;
      try {
        // Hash and sniff the finished file. Reading it back costs seconds, but it means no state has
        // to survive between requests and an interrupted piece can never poison the checksum.
        const hasher = createHash('sha256');
        let head = Buffer.alloc(0);
        await pipeline(
          createReadStream(s.tmpFile),
          new Writable({
            write(chunk: Buffer, _enc, cb) {
              hasher.update(chunk);
              if (head.length < 64) head = Buffer.concat([head, chunk]).subarray(0, 64);
              cb();
            },
          }),
        );
        sessions.delete(s.id);
        const media = await finalizeStoredMedia({
          companyId: s.companyId, userId: s.userId, folderId: s.folderId, originalName: s.fileName,
          tmpFile: s.tmpFile, mediaId: s.mediaId, size: s.size, sha256: hasher.digest('hex'), head,
        });
        audit({ userId: req.principal!.id, companyId: s.companyId, action: 'media.upload', entityId: media.id as string, ip: req.ip });
        notifyCompany(s.companyId, { type: 'sync' });
        return reply.code(201).send(media);
      } catch (err) {
        await discard(s); // finalize already removed the file on a rejection; this covers a failed read
        throw err;
      }
    });

    scope.delete('/api/media/uploads/:id', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const s = mine(req, id);
      if (!s) return reply.send({ ok: true }); // already gone is as good as cancelled
      await discard(s);
      return reply.send({ ok: true });
    });
  });
}
