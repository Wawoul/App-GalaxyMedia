import { statfs } from 'node:fs/promises';
import { config } from '../config.js';
import { query } from '../db/pool.js';

const MB = 1024 * 1024;

export interface QuotaInput {
  usedBytes: number;
  /** Size of the file about to be stored; unknown (0/NaN) counts as nothing. */
  incomingBytes: number;
  /** Company cap in bytes; 0 = unlimited. */
  quotaBytes: number;
  /** Free space on the media disk, or null when it could not be measured. */
  freeDiskBytes: number | null;
  /** Never let an upload leave less than this free. */
  minFreeBytes: number;
}

/**
 * May this company store this much more?
 *  - 'quota': it would exceed the company's own cap.
 *  - 'disk': it would eat into the headroom the whole server needs to keep running.
 * The quota is reported first, since it is the company's own limit to act on.
 */
export function quotaDecision(input: QuotaInput): 'ok' | 'quota' | 'disk' {
  const incoming = Number.isFinite(input.incomingBytes) && input.incomingBytes > 0 ? input.incomingBytes : 0;
  if (input.quotaBytes > 0 && input.usedBytes + incoming > input.quotaBytes) return 'quota';
  if (input.freeDiskBytes !== null && input.freeDiskBytes - incoming < input.minFreeBytes) return 'disk';
  return 'ok';
}

/** Looks up the company's usage and the disk, and decides. */
export async function checkRoom(companyId: string, incomingBytes: number): Promise<'ok' | 'quota' | 'disk'> {
  const { rows } = await query<{ used: string }>(
    'SELECT coalesce(sum(size_bytes), 0) AS used FROM media WHERE company_id = $1',
    [companyId],
  );
  let freeDiskBytes: number | null = null;
  try {
    const disk = await statfs(config.MEDIA_DIR);
    freeDiskBytes = disk.bavail * disk.bsize;
  } catch {
    // statfs unsupported here: don't block uploads on something we cannot measure.
  }
  return quotaDecision({
    usedBytes: Number(rows[0]?.used ?? 0),
    incomingBytes,
    quotaBytes: config.COMPANY_QUOTA_MB * MB,
    freeDiskBytes,
    minFreeBytes: config.MIN_FREE_DISK_MB * MB,
  });
}
