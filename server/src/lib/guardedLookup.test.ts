import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedAgent, guardedLookup } from './fetchUrl.js';

type Addr = { address: string; family: number };
type Resolver = (host: string, opts: object, cb: (err: Error | null, addrs?: Addr[]) => void) => void;

/** A resolver that returns a fixed answer, as DNS would. */
const resolvesTo = (...addrs: Addr[]): Resolver => (_h, _o, cb) => cb(null, addrs);
const pub = (address: string): Addr => ({ address, family: address.includes(':') ? 6 : 4 });

function run(resolver: Resolver, options: { all?: boolean } = { all: true }) {
  return new Promise<{ err: (Error & { statusCode?: number }) | null; result?: unknown; family?: unknown }>((resolve) => {
    guardedLookup(resolver)('files.example.com', options, (err, result, family) => resolve({ err, result, family }));
  });
}

/**
 * The URL check resolves a hostname, and the connection later resolves it AGAIN.
 * An attacker's DNS server can answer the first with a public address and the
 * second with 127.0.0.1 (DNS rebinding), walking straight past a check that only
 * ran once. This lookup runs at connection time, on the answer that is actually
 * about to be connected to.
 */
describe('guardedLookup', () => {
  it('passes public addresses through', async () => {
    const { err, result } = await run(resolvesTo(pub('93.184.216.34')));
    expect(err).toBeNull();
    expect(result).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('answers a single-address lookup the way net.connect expects', async () => {
    const { err, result, family } = await run(resolvesTo(pub('93.184.216.34')), { all: false });
    expect(err).toBeNull();
    expect(result).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('refuses a hostname that now resolves to a private or loopback address (rebinding)', async () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.77', '169.254.169.254', '172.16.0.1', '100.64.0.1', '0.0.0.0']) {
      const { err } = await run(resolvesTo(pub(address)));
      expect(err, address).not.toBeNull();
      expect(err!.message).toMatch(/not reachable/i);
      expect(err!.statusCode).toBe(400);
    }
  });

  it('refuses private IPv6 and IPv4-mapped forms', async () => {
    for (const address of ['::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:14d']) {
      const { err } = await run(resolvesTo(pub(address)));
      expect(err, address).not.toBeNull();
    }
  });

  it('refuses when ANY returned address is private, even beside a public one', async () => {
    const { err } = await run(resolvesTo(pub('93.184.216.34'), pub('127.0.0.1')));
    expect(err).not.toBeNull();
  });

  it('refuses an empty answer and passes resolver errors on', async () => {
    // (see also the end-to-end block below)
    expect((await run(resolvesTo())).err).not.toBeNull();
    const failing: Resolver = (_h, _o, cb) => cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    expect((await run(failing)).err?.message).toBe('ENOTFOUND');
  });
});

/**
 * The tests above prove the lookup's logic; this proves the HTTP client really
 * calls it on a live connection. If undici ignored the `connect.lookup` option
 * the guard would be decorative, and nothing else would notice.
 */
describe('guardedAgent on a real connection', () => {
  let server: ReturnType<typeof createServer>;
  let port = 0;
  let reached = false;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      reached = true;
      res.end('internal secret');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('never connects to a loopback server reached through a hostname', async () => {
    // "localhost" resolves to 127.0.0.1 here, i.e. exactly what a rebinding
    // attacker's hostname would resolve to on the second lookup.
    await expect(undiciFetch(`http://localhost:${port}/`, { dispatcher: guardedAgent })).rejects.toThrow();
    expect(reached).toBe(false);
  });

  it('proves the server above was reachable all along (so the refusal is the guard, not the setup)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('internal secret');
    expect(reached).toBe(true);
  });
});
