import { describe, expect, it } from 'vitest';
import { effectiveTimezone } from './effectiveTimezone.js';

const groups = (...tzs: [string, string | null][]) => tzs.map(([name, timezone]) => ({ name, timezone }));

describe('effectiveTimezone', () => {
  it("uses the screen's own timezone when it has one", () => {
    expect(effectiveTimezone('America/New_York', groups(['A', 'Australia/Sydney']))).toBe('America/New_York');
  });

  it('inherits from its first group when the screen has none', () => {
    // The schema says "NULL = inherit from first group", and the Schedule page tells the
    // user times are in the group's timezone - but nothing ever actually did this.
    expect(effectiveTimezone(null, groups(['Sydney shops', 'Australia/Sydney']))).toBe('Australia/Sydney');
  });

  it('picks the first group by name, so the answer does not depend on row order', () => {
    expect(effectiveTimezone(null, groups(['b-group', 'Asia/Tokyo'], ['a-group', 'Europe/Paris']))).toBe('Europe/Paris');
    expect(effectiveTimezone(null, groups(['a-group', 'Europe/Paris'], ['b-group', 'Asia/Tokyo']))).toBe('Europe/Paris');
  });

  it('falls back to London with no timezone anywhere', () => {
    expect(effectiveTimezone(null, [])).toBe('Europe/London');
    expect(effectiveTimezone(null, groups(['A', null]))).toBe('Europe/London');
  });

  it('ignores junk values rather than letting them break the schedule', () => {
    // A bad zone used to 500 the manifest and the dashboard outright.
    expect(effectiveTimezone('Mars/Olympus', groups(['A', 'Asia/Tokyo']))).toBe('Asia/Tokyo');
    expect(effectiveTimezone(null, groups(['A', 'not a zone'], ['B', 'Europe/Paris']))).toBe('Europe/Paris');
    expect(effectiveTimezone('+01:00', [])).toBe('Europe/London');
  });

  it('treats an empty string like no timezone', () => {
    expect(effectiveTimezone('', groups(['A', 'Asia/Tokyo']))).toBe('Asia/Tokyo');
  });
});
