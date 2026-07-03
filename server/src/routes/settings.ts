import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAlertSettings, saveAlertSettings, sendAlert } from '../alerts.js';
import { audit } from '../lib/audit.js';
import { encrypt } from '../lib/crypto.js';
import { isMspAdmin } from '../lib/permissions.js';
import { requireUser } from '../plugins/auth.js';

export function settingsRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    await requireUser(req, reply);
    if (reply.sent) return;
    if (!isMspAdmin(req.principal!)) return reply.code(403).send({ error: 'forbidden' });
  });

  // Secrets are write-only: the client only learns whether one is set.
  app.get('/api/settings/alerts', async (_req, reply) => {
    const s = await getAlertSettings();
    return reply.send({
      smtpHost: s.smtpHost,
      smtpPort: s.smtpPort,
      smtpUser: s.smtpUser,
      smtpPassSet: !!s.smtpPassEnc,
      smtpFrom: s.smtpFrom,
      alertEmails: s.alertEmails,
      telegramTokenSet: !!s.telegramTokenEnc,
      telegramChatId: s.telegramChatId,
      offlineAlertMinutes: s.offlineAlertMinutes,
    });
  });

  app.put('/api/settings/alerts', async (req, reply) => {
    const body = z
      .object({
        smtpHost: z.string().trim().max(200).default(''),
        smtpPort: z.number().int().min(1).max(65535).default(587),
        smtpUser: z.string().trim().max(200).default(''),
        smtpPass: z.string().max(500).nullish(), // null/undefined = keep existing; '' = clear
        smtpFrom: z.string().trim().max(200).default(''),
        alertEmails: z.string().trim().max(1000).default(''),
        telegramToken: z.string().trim().max(200).nullish(),
        telegramChatId: z.string().trim().max(100).default(''),
        offlineAlertMinutes: z.number().int().min(1).max(1440).default(5),
      })
      .parse(req.body);

    const current = await getAlertSettings();
    await saveAlertSettings({
      smtpHost: body.smtpHost,
      smtpPort: body.smtpPort,
      smtpUser: body.smtpUser,
      smtpPassEnc:
        body.smtpPass == null ? current.smtpPassEnc : body.smtpPass === '' ? '' : encrypt(body.smtpPass),
      smtpFrom: body.smtpFrom,
      alertEmails: body.alertEmails,
      telegramTokenEnc:
        body.telegramToken == null
          ? current.telegramTokenEnc
          : body.telegramToken === ''
            ? ''
            : encrypt(body.telegramToken),
      telegramChatId: body.telegramChatId,
      offlineAlertMinutes: body.offlineAlertMinutes,
    });
    audit({ userId: req.principal!.id, action: 'settings.alerts_update', ip: req.ip });
    return reply.send({ ok: true });
  });

  // Fire a test message on every configured channel; report per-channel results.
  app.post('/api/settings/alerts/test', async (req, reply) => {
    const result = await sendAlert(
      '✔ Galaxy Media test alert',
      `Test triggered from the Alerts tab by ${req.principal!.id}. If you can read this, the channel works.`,
    );
    audit({ userId: req.principal!.id, action: 'settings.alerts_test', ip: req.ip });
    return reply.send(result);
  });
}
