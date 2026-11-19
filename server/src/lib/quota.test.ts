import { describe, expect, it } from 'vitest';
import { quotaDecision } from './quota.js';

const MB = 1024 * 1024;
const base = { usedBytes: 100 * MB, incomingBytes: 10 * MB, quotaBytes: 0, freeDiskBytes: 50_000 * MB, minFreeBytes: 512 * MB };

describe('quotaDecision', () => {
  it('allows an upload when there is no quota and plenty of disk', () => {
    expect(quotaDecision(base)).toBe('ok');
  });

  it('treats a quota of 0 as unlimited', () => {
    expect(quotaDecision({ ...base, usedBytes: 10_000_000 * MB, quotaBytes: 0 })).toBe('ok');
  });

  it('refuses an upload that would take the company over its quota', () => {
    expect(quotaDecision({ ...base, quotaBytes: 105 * MB })).toBe('quota');
    expect(quotaDecision({ ...base, quotaBytes: 110 * MB })).toBe('ok'); // exactly full is allowed
    expect(quotaDecision({ ...base, quotaBytes: 109 * MB })).toBe('quota');
  });

  it('refuses when the server disk would drop below its floor, whatever the quota', () => {
    // One company filling the shared disk takes every other tenant down with it.
    expect(quotaDecision({ ...base, freeDiskBytes: 515 * MB })).toBe('disk'); // 515 - 10 < 512
    expect(quotaDecision({ ...base, freeDiskBytes: 522 * MB })).toBe('ok'); // 522 - 10 = 512
    expect(quotaDecision({ ...base, freeDiskBytes: 0 })).toBe('disk');
  });

  it('reports the quota first when both are exceeded', () => {
    expect(quotaDecision({ ...base, quotaBytes: 1 * MB, freeDiskBytes: 0 })).toBe('quota');
  });

  it('does not block on a disk it could not measure', () => {
    expect(quotaDecision({ ...base, freeDiskBytes: null })).toBe('ok');
  });

  it('copes with an unknown upload size by counting it as zero', () => {
    expect(quotaDecision({ ...base, incomingBytes: 0, quotaBytes: 100 * MB })).toBe('ok');
    expect(quotaDecision({ ...base, incomingBytes: Number.NaN, quotaBytes: 100 * MB })).toBe('ok');
  });
});
