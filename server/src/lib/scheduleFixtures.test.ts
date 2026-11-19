import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveActive, type LocalNow, type ScheduleEntry } from './schedule.js';

interface Fixture {
  name: string;
  entries: Partial<ScheduleEntry>[];
  now: LocalNow;
  expect: string | null;
}

const { cases } = JSON.parse(readFileSync(new URL('./schedule.fixtures.json', import.meta.url), 'utf8')) as {
  cases: Fixture[];
};

const full = (e: Partial<ScheduleEntry>): ScheduleEntry => ({
  id: 'x',
  playlistId: 'p',
  isDirect: false,
  createdAt: '2026-01-01T00:00:00Z',
  priority: 0,
  daysOfWeek: null,
  startTime: null,
  endTime: null,
  startDate: null,
  endDate: null,
  weekInterval: 1,
  ...e,
});

describe('schedule conformance fixtures (shared with the web and Android players)', () => {
  it('has fixtures', () => expect(cases.length).toBeGreaterThan(10));
  for (const c of cases) {
    it(c.name, () => {
      expect(resolveActive(c.entries.map(full), c.now)?.id ?? null).toBe(c.expect);
    });
  }
});
