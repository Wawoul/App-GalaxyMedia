import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ZodError } from 'zod';
import { startAlertLoop } from './alerts.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { authRoutes } from './routes/auth.js';
import { companyRoutes } from './routes/companies.js';
import { deviceRoutes } from './routes/device.js';
import { layoutRoutes } from './routes/layouts.js';
import { mediaRoutes } from './routes/media.js';
import { playlistRoutes } from './routes/playlists.js';
import { reportRoutes } from './routes/reports.js';
import { screenRoutes, screenshotRoute } from './routes/screens.js';
import { settingsRoutes } from './routes/settings.js';
import { systemRoutes } from './routes/system.js';
import { transferRoutes } from './routes/transfer.js';
import { userRoutes } from './routes/users.js';

async function main(): Promise<void> {
  await mkdir(config.MEDIA_DIR, { recursive: true });
  await migrate();

  const app = Fastify({
    logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
    // Trust exactly one hop (nginx on localhost). `true` would trust the whole
    // XFF chain and take the client-supplied leftmost entry as req.ip, which
    // nginx's `$proxy_add_x_forwarded_for` (append, not replace) lets a client
    // spoof - defeating IP-based rate limits like the pairing-code guard.
    trustProxy: 1,
    bodyLimit: 1024 * 1024, // JSON bodies; uploads go through multipart limits
  });

  await app.register(rateLimit, { global: false });
  await app.register(cookie);
  await app.register(websocket);
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  });
  await app.register(fastifyStatic, {
    root: config.MEDIA_DIR,
    serve: false, // only via reply.sendFile after auth checks
  });
  // Device screenshot uploads arrive as a raw JPEG body.
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // Single-container mode: serve the built admin UI (nginx does this on LXC installs).
  if (config.ADMIN_DIR) {
    await app.register(fastifyStatic, {
      root: config.ADMIN_DIR,
      decorateReply: false,
      index: 'index.html',
    });
    const indexHtml = await readFile(path.join(config.ADMIN_DIR, 'index.html'), 'utf8');
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback for non-API paths; API 404s stay JSON.
      if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      return reply.type('text/html').send(indexHtml);
    });
  }

  // Never leak internals (SPEC §8); validation errors get a clean 400.
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation', issues: err.issues });
    }
    const e = err as { statusCode?: unknown; message?: unknown };
    const status = typeof e.statusCode === 'number' ? e.statusCode : 500;
    if (status >= 500) req.log.error(err);
    return reply
      .code(status)
      .send({ error: status >= 500 ? 'internal' : String(e.message ?? 'error') });
  });

  app.get('/api/health', async () => ({ ok: true }));

  authRoutes(app);
  await app.register(async (s) => companyRoutes(s));
  await app.register(async (s) => userRoutes(s));
  await app.register(async (s) => screenRoutes(s));
  await app.register(async (s) => playlistRoutes(s));
  await app.register(async (s) => layoutRoutes(s));
  await app.register(async (s) => settingsRoutes(s));
  await app.register(async (s) => transferRoutes(s));
  await app.register(async (s) => reportRoutes(s));
  systemRoutes(app);
  mediaRoutes(app);
  deviceRoutes(app);
  screenshotRoute(app); // token-in-query auth; must stay outside screenRoutes' requireUser scope

  startAlertLoop(app.log);
  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
