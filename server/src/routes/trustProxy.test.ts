/**
 * Which address the app believes a client has. Every IP-based rate limit (login,
 * pairing) and the audit log hang off this, so it must be:
 *  - the real client when the request came through our proxy, and
 *  - NOT forgeable by anyone who reaches the app directly.
 *
 * Fastify 5.12 stopped honouring a numeric hop count ("trust 1 proxy") precisely
 * because it cannot check who the immediate peer is, so the proxy is now trusted by
 * address (config.TRUST_PROXY, default 127.0.0.1 where the bundled nginx runs).
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { config } from '../config.js';

async function ipSeenFor(remoteAddress: string, forwardedFor?: string) {
  const app = Fastify({ trustProxy: config.TRUST_PROXY });
  app.get('/ip', async (req) => ({ ip: req.ip }));
  await app.ready();
  const res = await app.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress,
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  });
  await app.close();
  return (JSON.parse(res.body) as { ip: string }).ip;
}

describe('trusted proxy handling', () => {
  it('trusts nginx on localhost by default', () => {
    expect(config.TRUST_PROXY).toBe('127.0.0.1');
  });

  it('reports the visitor nginx saw, not whatever the visitor claims', async () => {
    // nginx appends the address it saw to any X-Forwarded-For the client sent, so
    // the RIGHTMOST entry is the trustworthy one and anything to its left is the
    // client's own claim.
    expect(await ipSeenFor('127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
    expect(await ipSeenFor('127.0.0.1', '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
  });

  it('ignores X-Forwarded-For entirely from anything that is not the proxy', async () => {
    // Someone who reaches the app directly (an exposed Docker port, say) used to be
    // able to claim any address and dodge every rate limit.
    expect(await ipSeenFor('198.51.100.20', '6.6.6.6')).toBe('198.51.100.20');
    expect(await ipSeenFor('10.0.0.5', '6.6.6.6, 7.7.7.7')).toBe('10.0.0.5');
  });

  it('uses the connecting address when there is no forwarding header', async () => {
    expect(await ipSeenFor('127.0.0.1')).toBe('127.0.0.1');
    expect(await ipSeenFor('198.51.100.20')).toBe('198.51.100.20');
  });
});
