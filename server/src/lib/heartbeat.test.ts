import { describe, expect, it } from 'vitest';
import { heartbeatSchema } from './heartbeat.js';

const long = 'x'.repeat(2000); // playlist URLs may be up to 2000 chars (playlists.ts)

describe('heartbeatSchema', () => {
  it('accepts an empty body (very old players send nothing)', () => {
    const parsed = heartbeatSchema.parse({});
    expect(parsed.plays).toEqual([]);
  });

  it('clips an over-long currentItem instead of rejecting the whole heartbeat', () => {
    // A rejected heartbeat leaves the screen "offline", fires alerts and strands
    // the buffered proof-of-play. A long URL item must never cause that.
    const parsed = heartbeatSchema.parse({ currentItem: long });
    expect(parsed.currentItem).toHaveLength(200);
  });

  it('clips over-long play names but keeps the play', () => {
    const parsed = heartbeatSchema.parse({ plays: [{ name: long, at: '2026-01-01T00:00:00Z' }] });
    expect(parsed.plays).toHaveLength(1);
    expect(parsed.plays[0]!.name).toHaveLength(300);
  });

  it('clips mediaError and lastCrashMessage, which embed item names', () => {
    const parsed = heartbeatSchema.parse({ mediaError: `${long}: download 500`, lastCrashMessage: long });
    expect(parsed.mediaError).toHaveLength(500);
    expect(parsed.lastCrashMessage).toHaveLength(500);
  });

  it('leaves short values untouched', () => {
    const parsed = heartbeatSchema.parse({ currentItem: 'Menu.mp4', plays: [{ name: 'Menu.mp4', at: '2026-01-01T00:00:00.123Z' }] });
    expect(parsed.currentItem).toBe('Menu.mp4');
    expect(parsed.plays[0]!.name).toBe('Menu.mp4');
  });

  it('still rejects genuinely malformed data', () => {
    expect(() => heartbeatSchema.parse({ plays: [{ name: '', at: '2026-01-01T00:00:00Z' }] })).toThrow();
    expect(() => heartbeatSchema.parse({ plays: [{ name: 'a', at: 'yesterday' }] })).toThrow();
    expect(() => heartbeatSchema.parse({ batteryPct: 500 })).toThrow();
    expect(() => heartbeatSchema.parse({ plays: Array.from({ length: 501 }, () => ({ name: 'a', at: '2026-01-01T00:00:00Z' })) })).toThrow();
  });
});
