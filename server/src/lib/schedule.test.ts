import { describe, expect, it } from 'vitest';
import { isActive, nowInTimezone, resolveActive, type LocalNow, type ScheduleEntry } from './schedule.js';

function entry(overrides: Partial<ScheduleEntry>): ScheduleEntry {
  return {
    id: 'e1',
    playlistId: 'p1',
    isDirect: false,
    createdAt: '2026-01-01T00:00:00Z',
    priority: 0,
    daysOfWeek: null,
    startTime: null,
    endTime: null,
    startDate: null,
    endDate: null,
    ...overrides,
  };
}

const monday9am: LocalNow = { dateStr: '2026-07-06', dayOfWeek: 1, minutes: 9 * 60 };
const monday11pm: LocalNow = { dateStr: '2026-07-06', dayOfWeek: 1, minutes: 23 * 60 };
const monday1am: LocalNow = { dateStr: '2026-07-06', dayOfWeek: 1, minutes: 60 };

describe('isActive', () => {
  it('an all-null entry is always active (the default assignment)', () => {
    expect(isActive(entry({}), monday9am)).toBe(true);
  });

  it('respects days of week', () => {
    expect(isActive(entry({ daysOfWeek: [1, 2, 3] }), monday9am)).toBe(true);
    expect(isActive(entry({ daysOfWeek: [0, 6] }), monday9am)).toBe(false);
  });

  it('respects a same-day time window (breakfast menu until 11am)', () => {
    const breakfast = entry({ startTime: '06:00', endTime: '11:00' });
    expect(isActive(breakfast, monday9am)).toBe(true);
    expect(isActive(breakfast, monday11pm)).toBe(false);
    // end is exclusive: 11:00 exactly is no longer breakfast
    expect(isActive(breakfast, { ...monday9am, minutes: 11 * 60 })).toBe(false);
  });

  it('handles windows crossing midnight (22:00-02:00)', () => {
    const late = entry({ startTime: '22:00', endTime: '02:00' });
    expect(isActive(late, monday11pm)).toBe(true);
    expect(isActive(late, monday1am)).toBe(true);
    expect(isActive(late, monday9am)).toBe(false);
  });

  it('an overnight window restricted to one day of week keeps playing past midnight', () => {
    // Monday-only 22:00-02:00: still active at 1am Tuesday (the tail end of
    // Monday night), but not at 1am Wednesday (a plain night off).
    const mondayNight = entry({ startTime: '22:00', endTime: '02:00', daysOfWeek: [1] });
    expect(isActive(mondayNight, { dateStr: '2026-07-06', dayOfWeek: 1, minutes: 23 * 60 })).toBe(true); // Mon 11pm
    expect(isActive(mondayNight, { dateStr: '2026-07-07', dayOfWeek: 2, minutes: 60 })).toBe(true); // Tue 1am
    expect(isActive(mondayNight, { dateStr: '2026-07-08', dayOfWeek: 3, minutes: 60 })).toBe(false); // Wed 1am
    expect(isActive(mondayNight, { dateStr: '2026-07-07', dayOfWeek: 2, minutes: 23 * 60 })).toBe(false); // Tue 11pm
  });

  it('an overnight window respects a one-off end date past midnight', () => {
    // A single Friday-night slot: still counts as "Friday" at 1am Saturday.
    const fridayOnly = entry({ startTime: '22:00', endTime: '02:00', startDate: '2026-07-10', endDate: '2026-07-10' });
    expect(isActive(fridayOnly, { dateStr: '2026-07-11', dayOfWeek: 6, minutes: 60 })).toBe(true); // Sat 1am
    expect(isActive(fridayOnly, { dateStr: '2026-07-12', dayOfWeek: 0, minutes: 60 })).toBe(false); // Sun 1am
  });

  it('bi-weekly: active on anchor week, off the next, on again', () => {
    // Anchor Monday 2026-07-06; monday9am is that same day → week 0 (active).
    const biweekly = entry({ weekInterval: 2, startDate: '2026-07-06', daysOfWeek: [1] });
    expect(isActive(biweekly, monday9am)).toBe(true);
    // One week later → week 1 (inactive), two weeks later → week 2 (active).
    expect(isActive(biweekly, { ...monday9am, dateStr: '2026-07-13' })).toBe(false);
    expect(isActive(biweekly, { ...monday9am, dateStr: '2026-07-20' })).toBe(true);
    // Every 3 weeks
    const triweekly = entry({ weekInterval: 3, startDate: '2026-07-06', daysOfWeek: [1] });
    expect(isActive(triweekly, { ...monday9am, dateStr: '2026-07-13' })).toBe(false);
    expect(isActive(triweekly, { ...monday9am, dateStr: '2026-07-27' })).toBe(true);
  });

  it('respects date bounds', () => {
    expect(isActive(entry({ startDate: '2026-07-01', endDate: '2026-07-31' }), monday9am)).toBe(true);
    expect(isActive(entry({ endDate: '2026-07-05' }), monday9am)).toBe(false);
    expect(isActive(entry({ startDate: '2026-08-01' }), monday9am)).toBe(false);
  });
});

describe('resolveActive', () => {
  it('higher priority wins over the default', () => {
    const fallback = entry({ id: 'default', priority: 0 });
    const lunch = entry({ id: 'lunch', priority: 10, startTime: '11:00', endTime: '14:00' });
    expect(resolveActive([fallback, lunch], { ...monday9am, minutes: 12 * 60 })?.id).toBe('lunch');
    expect(resolveActive([fallback, lunch], monday9am)?.id).toBe('default');
  });

  it('direct-to-screen beats group at equal priority', () => {
    const group = entry({ id: 'group', isDirect: false });
    const direct = entry({ id: 'direct', isDirect: true });
    expect(resolveActive([group, direct], monday9am)?.id).toBe('direct');
  });

  it('newest wins at equal priority and directness', () => {
    const older = entry({ id: 'older', createdAt: '2026-01-01T00:00:00Z' });
    const newer = entry({ id: 'newer', createdAt: '2026-06-01T00:00:00Z' });
    expect(resolveActive([older, newer], monday9am)?.id).toBe('newer');
  });

  it('returns null when nothing matches', () => {
    const weekend = entry({ daysOfWeek: [0, 6] });
    expect(resolveActive([weekend], monday9am)).toBeNull();
  });
});

describe('nowInTimezone', () => {
  it('converts an instant into local wall-clock fields', () => {
    // 2026-07-06T08:30:00Z is 09:30 in London (BST) and 04:30 in New York (EDT); both Monday.
    const at = new Date('2026-07-06T08:30:00Z');
    const london = nowInTimezone('Europe/London', at);
    expect(london).toEqual({ dateStr: '2026-07-06', dayOfWeek: 1, minutes: 9 * 60 + 30 });
    const ny = nowInTimezone('America/New_York', at);
    expect(ny).toEqual({ dateStr: '2026-07-06', dayOfWeek: 1, minutes: 4 * 60 + 30 });
  });
});
