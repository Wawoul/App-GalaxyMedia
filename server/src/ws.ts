import type { WebSocket } from 'ws';
import { query } from './db/pool.js';

export type DevicePush =
  | { type: 'sync' } // content changed - refetch the manifest
  | { type: 'unpair' }
  | { type: 'command'; command: 'reload' | 'identify' | 'restart' | 'clear_cache' | 'screenshot' | 'update' };

const sockets = new Map<string, Set<WebSocket>>(); // screenId → connections
const alive = new WeakSet<WebSocket>();

const OPEN = 1; // ws.OPEN, without importing the runtime enum
const HEARTBEAT_MS = 30_000;

/**
 * A TV that loses power or drops off a NAT never sends a TCP FIN, so its socket
 * sits here for as long as the OS keeps it (nginx allows a 3600s read timeout).
 * Pushes to it would report success while going nowhere. Ping every 30s and drop
 * anything that missed the previous round.
 */
setInterval(() => {
  for (const [screenId, set] of sockets) {
    for (const socket of set) {
      if (!alive.has(socket)) {
        set.delete(socket);
        try {
          socket.terminate();
        } catch {
          /* already gone */
        }
        continue;
      }
      alive.delete(socket); // must be re-proved by a pong before the next sweep
      try {
        socket.ping();
      } catch {
        set.delete(socket);
      }
    }
    if (set.size === 0) sockets.delete(screenId);
  }
}, HEARTBEAT_MS).unref();

export function registerSocket(screenId: string, socket: WebSocket): void {
  let set = sockets.get(screenId);
  if (!set) {
    set = new Set();
    sockets.set(screenId, set);
  }
  set.add(socket);
  alive.add(socket);
  socket.on('pong', () => alive.add(socket));
  socket.on('error', () => {
    set.delete(socket);
    if (set.size === 0) sockets.delete(screenId);
  });
  socket.on('close', () => {
    set.delete(socket);
    if (set.size === 0) sockets.delete(screenId);
  });
}

/** Push to one screen. Returns true if at least one live socket received it. */
export function notifyScreen(screenId: string, message: DevicePush): boolean {
  const set = sockets.get(screenId);
  if (!set || set.size === 0) return false;
  const payload = JSON.stringify(message);
  let delivered = false;
  for (const socket of set) {
    // send() throws on a CLOSING/CLOSED socket, and this runs straight from
    // route handlers - an unguarded throw would surface as a 500 on an
    // otherwise fine admin action.
    if (socket.readyState !== OPEN) {
      set.delete(socket);
      continue;
    }
    try {
      socket.send(payload);
      delivered = true;
    } catch {
      set.delete(socket);
    }
  }
  if (set.size === 0) sockets.delete(screenId);
  return delivered;
}

/** Push to every screen of a company (content changes affect an unknown subset). */
export function notifyCompany(companyId: string, message: DevicePush): void {
  void query<{ id: string }>('SELECT id FROM screens WHERE company_id = $1', [companyId])
    .then(({ rows }) => {
      for (const row of rows) notifyScreen(row.id, message);
    })
    .catch(() => {});
}
