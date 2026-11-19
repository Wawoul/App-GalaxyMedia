import { z } from 'zod';

/**
 * A free-text field a device controls: shorten it, never refuse it.
 *
 * These carry item names, and a URL item's name IS its URL (up to 2000 chars).
 * Rejecting the field rejected the whole heartbeat with a 400, which the player
 * silently retried forever: the screen showed offline, offline alerts fired and
 * the buffered proof-of-play never cleared. Losing the tail of a label is a far
 * smaller harm than that.
 */
const clipped = (max: number) => z.string().transform((s) => s.slice(0, max));

export const heartbeatSchema = z.object({
  appVersion: z.string().max(50).optional(),
  currentItem: clipped(200).nullish(),
  storageFreeMb: z.number().int().nonnegative().optional(),
  // Device telemetry - all optional so old player builds keep working.
  batteryPct: z.number().int().min(0).max(100).nullish(),
  ramFreeMb: z.number().int().nonnegative().nullish(),
  ramTotalMb: z.number().int().nonnegative().nullish(),
  cpuPct: z.number().int().min(0).max(100).nullish(),
  wifiRssi: z.number().int().min(-127).max(0).nullish(),
  uptimeS: z.number().int().nonnegative().nullish(),
  // Reported by the device, unlike `ip` which is whatever hop reached us.
  localIp: z.string().max(45).nullish(), // 45 = longest IPv6 text form
  // Proof-of-play batch: items shown since the last successful heartbeat.
  plays: z
    .array(z.object({ name: clipped(300).pipe(z.string().min(1)), at: z.string().datetime() }))
    .max(500)
    .default([]),
  // Last uncaught exception since the previous confirmed report, if any.
  lastCrashAt: z.string().datetime().nullish(),
  lastCrashMessage: clipped(500).nullish(),
  // Why media could not be downloaded, if it could not (embeds the item's name).
  mediaError: clipped(500).nullish(),
});

export type Heartbeat = z.infer<typeof heartbeatSchema>;
