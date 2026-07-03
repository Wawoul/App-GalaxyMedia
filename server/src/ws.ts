import type { WebSocket } from 'ws';
import { query } from './db/pool.js';

export type DevicePush =
  | { type: 'sync' } // content changed - refetch the manifest
  | { type: 'unpair' }
  | { type: 'command'; command: 'reload' | 'identify' | 'restart' | 'clear_cache' | 'screenshot' | 'update' };

const sockets = new Map<string, Set<WebSocket>>(); // screenId → connections

export function registerSocket(screenId: string, socket: WebSocket): void {
  let set = sockets.get(screenId);
  if (!set) {
    set = new Set();
    sockets.set(screenId, set);
  }
  set.add(socket);
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
  for (const socket of set) socket.send(payload);
  return true;
}

/** Push to every screen of a company (content changes affect an unknown subset). */
export function notifyCompany(companyId: string, message: DevicePush): void {
  void query<{ id: string }>('SELECT id FROM screens WHERE company_id = $1', [companyId])
    .then(({ rows }) => {
      for (const row of rows) notifyScreen(row.id, message);
    })
    .catch(() => {});
}
